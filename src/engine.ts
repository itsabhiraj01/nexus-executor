import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client, type Pool } from 'pg';
import type { ExecutorConfig } from './config.js';
import type { SqlExecutor } from './db.js';
import { applyJobPermissions, parsePermissionPolicy, type RemotePermissionPolicy } from './permissions.js';
import { activeElapsed, reconcileManualApprovals } from './manual-approvals.js';
import {
  OpenCodeError,
  agentErrorSummary,
  asksUserForInput,
  collectToolProgress,
  compareMessageOrder,
  currentTurnResult,
  detectStall,
  evaluateToolProgress,
  fallbackPrompt,
  finalAssistantText,
  isModelFallbackError,
  lastAssistant,
  messageComplete,
  messageToEvents,
  parseModelRef,
  readToolFingerprints,
  turnErrored,
  type ModelRef,
  type OpenCodeClient,
  type OpenCodeMessage,
  type OpenCodeMessageError,
  type OpenCodePermissionRequest,
  type OpenCodeToolPart,
} from './opencode.js';
import {
  isModelPolicyDenial, registerModelPolicy, ModelPolicyError, type ExecutorModelPolicy,
} from './model-policy.js';
import {
  ConflictError,
  commitJobChanges,
  completeWorktreeMerge,
  execGit,
  listUnmergedPaths,
  linkNodeModules,
  materializeJobAgent,
  materializeJobSkills,
  materializeJobAttachments,
  mergeJobBranch,
  prepareWorktree,
  protectJobConfig,
  pullBaseIntoWorktree,
  removeJobWorkspace,
  resolveBaseRef,
  runDeployCommand,
  runJobCommand,
  jobEnv,
  syncCheckout,
  type AttachmentFile,
  type GitRunner,
  type JobAgentMaterialization,
} from './workspace.js';

/**
 * The executor's job engine — one OpenCode session per job for its whole
 * life, repairs and hub replies re-entering the same session, events folded
 * out of the polled message list, work committed to the job's branch after
 * every completed turn, and success gated on the verification command.
 * Adapted from the hub's `modules/builder/src/engine.ts` +
 * `worker.ts`, reduced to a single-job lifecycle.
 *
 * Operational state lives on `executor.jobs`; the timeline is append-only
 * `executor.job_events` with the hub's self-healing sequence allocation
 * (event_seq = GREATEST(counter, max(sequence_number)) + 1 under the row
 * lock — an out-of-band insert can never wedge the stream).
 */

/* ── Types ─────────────────────────────────────────────────────────────── */

export type JobStatus =
    'created' | 'queued' | 'running' | 'waiting_for_user' | 'verifying'
  | 'failed' | 'succeeded' | 'cancelled';

export const TERMINAL_STATUSES: readonly JobStatus[] = ['failed', 'succeeded', 'cancelled'];

/** Statuses that occupy one of the executor's parallel slots — mirrors the
 *  hub's `slotOccupyingStatuses` idea: `queued` waits FOR a slot and a job
 *  parked on the user (`waiting_for_user`) releases its own. */
export const SLOT_OCCUPYING_STATUSES: readonly JobStatus[] = ['created', 'running', 'verifying'];

export interface ProjectSpec {
  name?: string;
  /** Reference to an executor-registered project (`executor.projects`). When
   *  present the executor resolves it to its own dir_path/git_remote — the
   *  authority for the working copy. */
  projectName?: string;
  repoUrl?: string;
  localPath?: string;
  buildCommand?: string;
  runCommand?: string;
  testCommand?: string;
  customPrompt?: string;
}

export interface JobAttachmentInput {
  name: string;
  mimeType: string;
  dataBase64: string;
}

/** The in-job retry budget the hub resolved for this job (both fields
 *  optional — the executor's own env defaults fill the gaps). */
export interface JobRetrySpec {
  /** Total attempts (1 = no retries). */
  maxAttempts?: number;
  /** Minutes between a retryable failure and the requeued attempt. */
  delayMinutes?: number;
}

/** The job spec exactly as `POST /api/v1/jobs` received it. */
export interface JobSpecInput {
  manualApprovals?: boolean;
  permissionPolicy?: RemotePermissionPolicy;
  jobId: string;
  title?: string;
  prompt: string;
  verificationCommand?: string;
  project?: ProjectSpec | null;
  models?: string[];
  /** The agent-derived provider fence (hub ≥ agent-model-policy contract):
   *  written into the job's worktree and proven with a canary before the
   *  first session — legacy jobs (absent/null) run unfenced. */
  modelPolicy?: ExecutorModelPolicy | null;
  /** The pre-rendered native persona (hub ≥ nativeAgents capability):
   *  materialized into the job's worktree BEFORE the first session opens
   *  (the model-policy canary included — a directory's project-agent
   *  catalog freezes at its first session) and pinned on the session. */
  agent?: JobAgentMaterialization | null;
  attachments?: JobAttachmentInput[];
  retry?: JobRetrySpec | null;
  /** Pipeline stage: attach to this EXISTING branch instead of cutting a new
   *  worktree (missing branch at launch ⇒ workspace_setup_failed — a branch
   *  is sacred, never silently re-cut). */
  baseBranch?: string;
  /** Pipeline stage: run verification BEFORE any agent prompt (fail ⇒ a
   *  repair session; pass ⇒ the job ends with NO session at all). */
  verifyFirst?: boolean;
  /** Pipeline stage: pull the base ref into the worktree BEFORE anything
   *  else (conflicts open a bounded repair loop). */
  rebaseFirst?: boolean;
  /** Pipeline stage: park waiting_for_user at turn end instead of
   *  verifying+succeeding (a message resumes; the next turn end parks again). */
  parkOnTurnEnd?: boolean;
}

export interface JobRow {
  id: string;
  hubJobId: string;
  status: JobStatus;
  title: string;
  spec: JobSpecInput;
  prompt: string;
  verificationCommand: string;
  verificationAttemptCount: number;
  branch: string;
  worktreePath: string;
  opencodeSessionId: string | null;
  model: string;
  failureReason: string | null;
  errorCode: string | null;
  summary: string;
  mergedSha: string;
  /** The 1-based attempt currently (or last) running. */
  attemptCount: number;
  /** The resolved retry budget (1 = no retries). */
  maxAttempts: number;
  /** A requeued attempt launches only at/after this instant. */
  retryBackoffUntil: Date | null;
  eventSeq: number;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

interface DbJobRow {
  id: string;
  hub_job_id: string;
  status: string;
  title: string;
  spec: unknown;
  prompt: string;
  verification_command: string;
  verification_attempt_count: number;
  branch: string;
  worktree_path: string;
  opencode_session_id: string | null;
  model: string;
  failure_reason: string | null;
  error_code: string | null;
  summary: string;
  merged_sha: string;
  attempt_count: number;
  max_attempts: number;
  retry_backoff_until: Date | null;
  event_seq: string | number;
  metadata: unknown;
  version: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

export function rowToJob(row: DbJobRow): JobRow {
  return {
    id: row.id,
    hubJobId: row.hub_job_id,
    status: row.status as JobStatus,
    title: row.title,
    spec: (row.spec ?? {}) as JobSpecInput,
    prompt: row.prompt,
    verificationCommand: row.verification_command,
    verificationAttemptCount: row.verification_attempt_count,
    branch: row.branch,
    worktreePath: row.worktree_path,
    opencodeSessionId: row.opencode_session_id,
    model: row.model,
    failureReason: row.failure_reason,
    errorCode: row.error_code,
    summary: row.summary,
    mergedSha: row.merged_sha,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    retryBackoffUntil: row.retry_backoff_until,
    eventSeq: Number(row.event_seq),
    metadata: (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata : {}) as Record<string, unknown>,
    version: row.version,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

export async function getJobByHubId(db: SqlExecutor, hubJobId: string): Promise<JobRow | null> {
  const { rows } = await db.query<DbJobRow>(
    `SELECT * FROM executor.jobs WHERE hub_job_id = $1`, [hubJobId]);
  return rows[0] ? rowToJob(rows[0]) : null;
}

/** An HTTP-mappable failure out of the engine. */
export class EngineError extends Error {
  constructor(readonly statusCode: number, message: string, readonly extra?: Record<string, unknown>) {
    super(message);
  }
}

/* ── Events ────────────────────────────────────────────────────────────── */

/** Event type vocabulary — aligned with the hub's builder engine so the
 *  hub can render executor timelines with the same chips. */
export const EVENT = {
  SESSION_CREATED: 'SESSION_CREATED',
  PROMPT_SENT: 'PROMPT_SENT',
  HUB_MESSAGE: 'HUB_MESSAGE',
  AGENT_MESSAGE: 'AGENT_MESSAGE',
  AGENT_REASONING: 'AGENT_REASONING',
  AGENT_ERROR: 'AGENT_ERROR',
  TOOL_CALL_STARTED: 'TOOL_CALL_STARTED',
  TOOL_CALL_FINISHED: 'TOOL_CALL_FINISHED',
  TOOL_CALL_FAILED: 'TOOL_CALL_FAILED',
  PERMISSION_REJECTED: 'PERMISSION_REJECTED',
  AGENT_IDLE: 'AGENT_IDLE',
  AGENT_ASKED_USER: 'AGENT_ASKED_USER',
  USER_INPUT_REQUESTED: 'USER_INPUT_REQUESTED',
  VERIFICATION_STARTED: 'VERIFICATION_STARTED',
  VERIFICATION_PASSED: 'VERIFICATION_PASSED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  REPAIR_REQUESTED: 'REPAIR_REQUESTED',
  EXECUTION_SUCCEEDED: 'EXECUTION_SUCCEEDED',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  EXECUTION_CANCELLED: 'EXECUTION_CANCELLED',
  EXECUTION_STATUS_CHANGED: 'EXECUTION_STATUS_CHANGED',
  WORKTREE_CREATED: 'WORKTREE_CREATED',
  WORKTREE_CHECKPOINT_FAILED: 'WORKTREE_CHECKPOINT_FAILED',
  WORKTREE_HANDOFF_CHECKPOINTED: 'WORKTREE_HANDOFF_CHECKPOINTED',
  WORKTREE_MERGED: 'WORKTREE_MERGED',
  WORKTREE_MERGE_FAILED: 'WORKTREE_MERGE_FAILED',
  WORKTREE_DEPLOYED: 'WORKTREE_DEPLOYED',
  WORKTREE_DEPLOY_FAILED: 'WORKTREE_DEPLOY_FAILED',
  AGENT_APPLIED: 'AGENT_APPLIED',
  WORKSPACE_CLEANED: 'WORKSPACE_CLEANED',
  WORKSPACE_RETENTION_VIOLATION: 'WORKSPACE_RETENTION_VIOLATION',
  AUTO_RETRY_SCHEDULED: 'AUTO_RETRY_SCHEDULED',
  AUTO_RETRY_STARTED: 'AUTO_RETRY_STARTED',
  MODEL_POLICY: 'MODEL_POLICY',
  MODEL_POLICY_BLOCKED: 'MODEL_POLICY_BLOCKED',
  MODEL_FALLBACK: 'MODEL_FALLBACK',
  REBASE_CLEAN: 'REBASE_CLEAN',
  REBASE_MERGED: 'REBASE_MERGED',
  REBASE_CONFLICTS: 'REBASE_CONFLICTS',
  REBASE_FAILED: 'REBASE_FAILED',
} as const;

/** The retention sweep runs at most this often (the tick is seconds). */
export const WORKSPACE_SWEEP_INTERVAL_MS = 60 * 60_000;

/** One retention violation: a terminal job past the workspace-retention
 *  window still holding its worktree + branch. */
export interface StaleWorkspace {
  jobId: string;
  status: string;
  title: string;
  branch: string;
  worktreePath: string;
  repoRoot: string;
  finishedAt: Date;
  /** A WORKSPACE_RETENTION_VIOLATION event was already appended. */
  notified: boolean;
}

/**
 * Failure classes the executor retries INSIDE the job (same branch, fresh
 * session, continuation preamble): the transient ones — a wedged or errored
 * agent turn, the job ceiling, session-setup hiccups. Everything else is a
 * verdict: workspace/config mistakes (they fail identically every attempt)
 * and exhausted verifications (the repair loop already spent its chances).
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'agent_stalled',
  'agent_error',
  'execution_timeout',
  'session_setup_failed',
]);

/** The retry budget one job resolves: the spec's pin, else the executor's
 *  env default, clamped to the route's envelope (1 = no retries). */
export function resolveMaxAttempts(spec: JobSpecInput, config: ExecutorConfig): number {
  const raw = spec.retry?.maxAttempts ?? config.retryMaxAttempts;
  if (!Number.isFinite(raw)) return 1;
  return Math.min(10, Math.max(1, Math.floor(raw)));
}

/** Minutes between a retryable failure and the requeued attempt's launch. */
export function resolveRetryDelayMinutes(spec: JobSpecInput, config: ExecutorConfig): number {
  const raw = spec.retry?.delayMinutes ?? config.retryDelayMinutes;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(60, Math.max(0, Math.floor(raw)));
}

/** The first line of a failure reason, for one-sentence preambles. */
function firstLine(text: string, limit = 240): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line || '(no reason recorded)';
}

/**
 * The agent-facing preamble of a RETRIED job's first prompt: the new
 * session starts cold, so it must be told what happened and — crucially —
 * that the branch already carries the previous attempt's checkpointed
 * work to continue from instead of starting over.
 */
export function retryPreamble(input: {
  attempt: number; maxAttempts: number; errorCode: string; reason: string; branchCommitted: boolean;
}): string {
  return [
    `This is attempt ${input.attempt} of ${input.maxAttempts} for this job — attempt ${input.attempt - 1} failed (${input.errorCode}): ${firstLine(input.reason)}`,
    input.branchCommitted
      ? 'The previous attempt\'s work up to its last completed turn is committed on this branch — inspect it (`git log -5`, `git status`) and CONTINUE from there instead of starting over.'
      : 'The worktree may carry uncommitted leftovers from the previous attempt — inspect the state (`git status`, `git log -5`) and continue from there instead of starting over.',
    'When the work is done, end your turn with the usual summary.',
  ].join('\n\n');
}

const SUMMARY_LIMIT = 200;
const PAYLOAD_LIMIT = 512 * 1024;

/** Cap an event payload for storage (mirrors the hub's capPayload). */
function capPayload(payload: unknown): Record<string, unknown> {
  if (payload === undefined || payload === null) return {};
  const base = typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : { value: payload };
  const serialized = JSON.stringify(base) ?? '{}';
  if (serialized.length > PAYLOAD_LIMIT) return { truncated: true, bytes: serialized.length };
  return base;
}

/**
 * Append one event. Bumps `event_seq` (and `updated_at`) on the job and
 * inserts the timeline row with the allocated sequence number. The
 * allocation is `GREATEST(event_seq, max(sequence_number)) + 1`, so an
 * out-of-band timeline insert self-heals on the next append instead of
 * wedging the stream; concurrent appends stay correct because the counter
 * is bumped under the job's row lock. Retries up to 5 on 23505 (a racing
 * insert between the two statements inherits the new number next round).
 */
export async function appendJobEvent(db: SqlExecutor, input: {
  jobId: string;
  eventType: string;
  source?: 'executor' | 'opencode' | 'hub';
  summary: string;
  payload?: unknown;
  messageId?: string | null;
}): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const inserted = await db.query<{ sequence_number: string | number }>(`
      WITH bumped AS (
      UPDATE executor.jobs SET
        event_seq = GREATEST(
          event_seq,
          (SELECT COALESCE(MAX(sequence_number), 0) FROM executor.job_events WHERE job_id = $1)) + 1,
        updated_at = NOW()
      WHERE id = $1 AND (status NOT IN ('failed', 'succeeded', 'cancelled') OR $2 = ANY($7::text[]))
      RETURNING event_seq)
        INSERT INTO executor.job_events (job_id, sequence_number, event_type, source, summary, payload, message_id)
        SELECT $1, event_seq, $2, $3, $4, $5::jsonb, $6 FROM bumped RETURNING sequence_number`, [
        input.jobId,
        input.eventType,
        input.source ?? 'executor',
        input.summary.slice(0, SUMMARY_LIMIT),
        JSON.stringify(capPayload(input.payload)),
        input.messageId ?? null,
        [EVENT.EXECUTION_SUCCEEDED, EVENT.EXECUTION_FAILED, EVENT.EXECUTION_CANCELLED,
          EVENT.WORKTREE_MERGED, EVENT.WORKTREE_MERGE_FAILED, EVENT.WORKTREE_DEPLOYED,
          EVENT.WORKTREE_DEPLOY_FAILED, EVENT.WORKSPACE_CLEANED, EVENT.WORKSPACE_RETENTION_VIOLATION,
          EVENT.WORKTREE_HANDOFF_CHECKPOINTED],
      ]);
      // Stale lifecycle work must not append after the terminal EOF marker.
      return Number(inserted.rows[0]?.sequence_number ?? 0);
    } catch (error) {
      if ((error as { code?: string }).code === '23505' && attempt < 4) continue;
      throw error;
    }
  }
  /* istanbul ignore next -- unreachable: the loop returns or throws */
  throw new Error('event allocation failed');
}

/* ── Prompt composition ────────────────────────────────────────────────── */

export function repairPrompt(command: string, result: { code: number; output: string }): string {
  return [
    `The verification command \`${command}\` failed with exit code ${result.code}.`,
    '',
    '```',
    result.output || '(no output)',
    '```',
    '',
    'Fix the problem in this session and make the verification command pass.',
  ].join('\n');
}

/** The conflict-resolution prompt for the rebase stage (mirrors the hub's
 *  rebasePrompt text — the stage feels identical local or remote). */
export function rebaseConflictPrompt(conflicts: readonly string[], baseRef: string): string {
  return [
    `The ${baseRef} branch moved ahead of your branch, and pulling it into your worktree produced merge conflicts in:`,
    '',
    ...conflicts.slice(0, 30).map((path) => `- ${path}`),
    ...(conflicts.length > 30 ? [`- (…${conflicts.length - 30} more)`] : []),
    '',
    'Resolve the conflicts in your worktree: edit the marked files keeping both sides\' intent, then `git add` every resolved file and commit the merge (`git commit --no-edit`). Do NOT abort the merge. After resolving, the merge completes and any verification command runs.',
  ].join('\n');
}

/** The feedback an auto-rejected approval carries: why it died, how to fix. */
export const PERMISSION_REJECT_FEEDBACK =
  'Unattended run — no human is here to approve this, so it was denied. ' +
  'Commands this agent may run must be pre-allowed in its persona permission map.';

/** The stall failure reason (mirrors the hub's wording, minus the
 *  OpenCode-version specifics). */
export function stallFailureReason(summary: string, interrupted?: boolean): string {
  return [
    `Agent stalled — ${summary}. This matches the known OpenCode wedge (a tool call marked running never executes; a nudge cannot help — the stuck turn never reads messages, only an interrupt unsticks it).`,
    'Pending permission approvals are auto-rejected in unattended runs, so an unanswered `ask` cannot be the cause.',
    interrupted
      ? 'The OpenCode session was interrupted and the job failed so it can be retried; completed turns stay checkpointed on the job\'s branch.'
      : 'The job failed so it can be retried; completed turns stay checkpointed on the job\'s branch.',
  ].join(' ');
}

/** The agent-facing branch/worktree name suffix for one hub job id. */
export function jobShortId(hubJobId: string): string {
  const clean = hubJobId.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 12);
  return clean || createHash('sha256').update(hubJobId).digest('hex').slice(0, 12);
}

const MAX_VERIFICATION_ATTEMPTS = 3;
const MAX_REBASE_ROUNDS = 3;
const SEEN_IDS_CAP = 500;
class AttemptInterrupted extends Error {}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/* ── Engine ────────────────────────────────────────────────────────────── */

export interface JobEngineOptions {
  pool: Pool;
  config: ExecutorConfig;
  /** Null when OPENCODE_BASE_URL is unset — the executor stores and queues
   *  jobs but cannot run them. */
  client: OpenCodeClient | null;
  git?: GitRunner;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export class JobEngine {
  private readonly pool: Pool;
  readonly config: ExecutorConfig;
  private readonly client: OpenCodeClient | null;
  readonly git: GitRunner;
  private readonly nowFn: () => number;
  private readonly onError: (error: unknown) => void;
  private readonly verifyingJobs = new Set<string>();
  private readonly launchingJobs = new Set<string>();
  private readonly commands = new Map<string, AbortController>();
  private readonly deadlines = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> }>();
  /** Detached verification cycles — tests drain them via `drain()`. */
  private readonly pending = new Set<Promise<unknown>>();
  /** Retention-sweep throttle: the tick is seconds; the sweep is hourly. */
  private lastWorkspaceSweepAt = 0;

  constructor(options: JobEngineOptions) {
    this.pool = options.pool;
    this.config = options.config;
    this.client = options.client;
    this.git = options.git ?? execGit;
    this.nowFn = options.now ?? Date.now;
    this.onError = options.onError ?? (() => {});
  }

  now(): number {
    return this.nowFn();
  }

  async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  private track(work: Promise<unknown>): void {
    const wrapped = work.catch((error) => this.onError(error)).finally(() => {
      this.pending.delete(wrapped);
    });
    this.pending.add(wrapped);
  }

  /* ── Admission ─────────────────────────────────────────────────────── */

  /** Create the job row (idempotent on hub_job_id) and admit it. */
  async createJob(spec: JobSpecInput): Promise<{ job: JobRow; created: boolean }> {
    const permissionPolicy = spec.permissionPolicy === undefined ? null : parsePermissionPolicy(spec.permissionPolicy);
    const inserted = await this.pool.query<DbJobRow>(`
      INSERT INTO executor.jobs (hub_job_id, title, spec, prompt, verification_command, max_attempts, permission_policy)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb)
      ON CONFLICT (hub_job_id) DO NOTHING
      RETURNING *`, [
      spec.jobId,
      spec.title ?? '',
      JSON.stringify(spec),
      spec.prompt,
      spec.verificationCommand ?? '',
      resolveMaxAttempts(spec, this.config),
      permissionPolicy ? JSON.stringify(permissionPolicy) : null,
    ]);
    if (!inserted.rows[0]) {
      const existing = await getJobByHubId(this.pool, spec.jobId);
      if (!existing) throw new Error(`Job ${spec.jobId} was simultaneously deleted`);
      return { job: existing, created: false };
    }
    const job = rowToJob(inserted.rows[0]);
    // Durable acceptance: the worker owns launch, including after a restart.
    if (!this.client) {
      await this.queueJob(job, 'OpenCode is not configured — the job waits queued.');
      return { job: (await getJobByHubId(this.pool, spec.jobId))!, created: true };
    }
    return { job, created: true };
  }

  private async queueJob(job: JobRow, summary: string, reason = 'opencode_unavailable'): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE executor.jobs SET status = 'queued', started_at = NULL, version = version + 1, updated_at = NOW()
       WHERE id = $1 AND status = 'created' AND (NOT $2::boolean OR started_at IS NULL)`, [job.id, reason === 'capacity']);
    if (rowCount) {
      const deadline = this.deadlines.get(job.id);
      if (deadline) clearTimeout(deadline.timer);
      this.deadlines.delete(job.id);
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.EXECUTION_STATUS_CHANGED, summary, payload: { status: 'queued', reason },
      });
    }
  }

  /**
   * Worker admission step: heal leftover `created` rows (a crash between
   * insert and launch) and promote queued jobs while slots are free.
   */
  async admitQueued(): Promise<void> {
    const { rows } = await this.pool.query<DbJobRow>(`
      SELECT * FROM executor.jobs WHERE status IN ('created', 'queued')
        AND (retry_backoff_until IS NULL OR retry_backoff_until <= NOW())
        ORDER BY created_at ASC LIMIT 25`);
    for (const raw of rows) {
      const job = rowToJob(raw);
      if (!this.client) await this.queueJob(job, 'OpenCode is not configured — the job waits queued.');
      else this.track(this.launchJob(job));
    }
  }

  /* ── Launch ────────────────────────────────────────────────────────── */

  private async resolveRepoRoot(spec: JobSpecInput): Promise<string> {
    const project = spec.project;
    // Executor-owned project reference: resolve to this machine's registered
    // directory. The executor (not the hub) is the authority on the path.
    if (project?.projectName) {
      const dir = await this.resolveRegisteredProject(project.projectName);
      await this.fetchRegisteredRemote(dir).catch(() => undefined);
      return dir;
    }
    if (project?.localPath) {
      // Best-effort fetch a registered dir's remote so the job runs against
      // fresh state. Non-git / non-registered dirs are used as-is (plain dir
      // work is an allowed mode when no remote is configured).
      await this.fetchRegisteredRemote(project.localPath).catch(() => undefined);
      return project.localPath;
    }
    if (project?.repoUrl) return this.cloneRepo(project.repoUrl);
    throw new Error('The job project must carry a projectName, localPath or a repoUrl — there is nowhere to work.');
  }

  /** Look up an executor-registered project by name and answer its dir_path.
   *  Throws when the name is unknown or the directory has since vanished. */
  private async resolveRegisteredProject(name: string): Promise<string> {
    const { rows } = await this.pool.query<{ dir_path: string }>(
      `SELECT dir_path FROM executor.projects WHERE name = $1 LIMIT 1`,
      [name],
    );
    const dir = rows[0]?.dir_path;
    if (!dir) {
      throw new Error(`Executor cannot accept this job: project "${name}" is not registered on this executor (run 'nexus-executor project add ${name} --dir <path>')).`);
    }
    if (!existsSync(dir)) {
      throw new Error(`Executor cannot accept this job: registered project "${name}" points at a missing directory ${dir}`);
    }
    return dir;
  }

  /** If `dir` is a git repo, fetch `--all --prune` (no-op/ignored otherwise).
   *  Never throws to the caller — best-effort. */
  private async fetchRegisteredRemote(dir: string): Promise<void> {
    if (!existsSync(join(dir, '.git'))) return;
    const probe = await this.git(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
    if (probe.code !== 0) return;
    await this.git(['fetch', '--all', '--prune'], { cwd: dir });
  }

  /** Clone (once) into `<workspaceRoot>/repos/<sha1(url)>` and fetch on
   *  later use (best effort — offline machines build from what's there). */
  private async cloneRepo(repoUrl: string): Promise<string> {
    const name = createHash('sha256').update(repoUrl).digest('hex').slice(0, 12);
    const dir = join(this.config.workspaceRoot, 'repos', name);
    if (!existsSync(join(dir, '.git'))) {
      await this.git(['clone', repoUrl, dir], {});
      const probe = await this.git(['rev-parse', '--is-inside-work-tree'], { cwd: dir });
      if (probe.code !== 0) {
        throw new Error(`git clone of ${repoUrl} failed`);
      }
    } else {
      await this.git(['fetch', '--all', '--prune'], { cwd: dir });
    }
    return dir;
  }

  /**
   * Re-materialize a RETRIED job's workspace: the branch (the previous
   * attempt's committed work) is sacred — the worktree is re-attached on it
   * when missing, reused when present. Throws when the branch itself is
   * gone (the attempt cannot continue; the job fails with a clean reason).
   */
  private async resumeWorkspace(repoRoot: string, job: JobRow): Promise<{ branch: string; path: string; baseSha: string }> {
    const branch = job.branch;
    const baseSha = typeof job.metadata.baseSha === 'string' ? job.metadata.baseSha : '';
    let path = job.worktreePath;
    if (!path || !existsSync(path)) {
      path = join(this.config.workspaceRoot, 'worktrees', branch);
      const probe = await this.git(['rev-parse', '--verify', '--quiet', branch], { cwd: repoRoot });
      if (probe.code !== 0) {
        throw new Error(`The previous attempt's branch "${branch}" is gone — the job cannot continue from its work.`);
      }
      await this.git(['worktree', 'prune'], { cwd: repoRoot });
      const added = await this.git(['worktree', 'add', path, branch], { cwd: repoRoot });
      if (added.code !== 0) {
        throw new Error(`Re-attaching the worktree for "${branch}" failed: ${added.stderr || added.stdout}`);
      }
    }
    return { branch, path, baseSha };
  }

  /** Attach an EXISTING stage branch in a fresh per-job location. A previous
   * executor-owned, idle worktree is retained detached. Terminal stages have
   * their remaining changes checkpointed before release, never discarded. Missing branch
   * ⇒ workspace_setup_failed — a stage branch is sacred, never re-cut. */
  private async attachNamedBranch(repoRoot: string, baseBranch: string, jobId: string, owner: SqlExecutor): Promise<{ branch: string; path: string; baseSha: string }> {
    const probe = await this.git(['rev-parse', '--verify', '--quiet', `${baseBranch}^{commit}`], { cwd: repoRoot });
    if (probe.code !== 0 || !probe.stdout.trim()) {
      throw Object.assign(
        new Error(`Branch ${baseBranch} is gone — rerun from an earlier pipeline stage to re-create it.`),
        { code: 'workspace_setup_failed' },
      );
    }
    const preferred = join(this.config.workspaceRoot, 'worktrees', `stage-${jobId}`);
    if (existsSync(preferred)) {
      const onBranch = await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: preferred });
      if (onBranch.stdout.trim() === baseBranch) return { branch: baseBranch, path: preferred, baseSha: probe.stdout.trim() };
    }
    await this.git(['worktree', 'prune'], { cwd: repoRoot });
    const added = await this.git(['worktree', 'add', preferred, baseBranch], { cwd: repoRoot });
    if (added.code !== 0) {
      // Each stage needs a fresh OpenCode location AND fresh generated config.
      // Leave the old worktree on disk detached; never reuse its cached catalog.
      if (/already (checked out|used by worktree)/.test(added.stderr || added.stdout)) {
        const listed = await this.git(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
        for (const block of listed.stdout.split('\n\n')) {
          const path = /^worktree (.+)$/m.exec(block)?.[1];
          const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
          if (branch === baseBranch && path && existsSync(path)) {
            const known = await this.pool.query<{ id: string }>('SELECT id FROM executor.jobs WHERE worktree_path = $1 AND id <> $2 ORDER BY id', [path, jobId]);
            if (!known.rowCount) throw Object.assign(new Error('The branch is checked out outside an executor-owned stage.'), { code: 'workspace_setup_failed' });
            // Share ownership with polling, launch, continuations and verification.
            // A cancelled verification may still be exiting; terminal status alone
            // does not prove that no process is writing to the worktree.
            for (const previous of known.rows) {
              const lock = await owner.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [previous.id]);
              if (!lock.rows[0]?.locked) throw Object.assign(new Error('The previous stage still has an active operation; retry after it finishes.'), { code: 'workspace_setup_failed' });
            }
            const active = await this.pool.query(`SELECT id FROM executor.jobs WHERE worktree_path = $1
              AND status IN ('queued', 'created', 'running', 'verifying') AND id <> $2`, [path, jobId]);
            if (active.rowCount) {
              throw Object.assign(new Error('The previous stage is active; finish it before handing off the branch.'), { code: 'workspace_setup_failed' });
            }
            let dirty = await this.git(['status', '--porcelain'], { cwd: path });
            if (dirty.code === 0 && dirty.stdout.trim()) {
              const previous = (await this.pool.query<{ id: string; status: JobStatus; opencode_session_id: string | null }>(
                'SELECT id, status, opencode_session_id FROM executor.jobs WHERE worktree_path = $1 ORDER BY created_at DESC LIMIT 1', [path])).rows[0]!;
              if (!TERMINAL_STATUSES.includes(previous.status)) {
                throw Object.assign(new Error('The previous stage has uncommitted changes and is waiting for input; finish it before handing off the branch.'), { code: 'workspace_setup_failed' });
              }
              try {
                // Cancellation interrupts best-effort. Require a successful stop
                // here before snapshotting; a vanished session (404) is also safe.
                if (previous.opencode_session_id) {
                  if (!this.client) throw new Error('OpenCode is unavailable');
                  try { await this.client.interrupt(previous.opencode_session_id); }
                  catch (error) { if (!(error instanceof OpenCodeError && error.status === 404)) throw error; }
                }
                const checkpoint = await commitJobChanges(this.git, { path, message: 'executor: checkpoint before stage handoff' });
                await appendJobEvent(this.pool, {
                  jobId: previous.id, eventType: EVENT.WORKTREE_HANDOFF_CHECKPOINTED,
                  summary: 'Preserved remaining stage changes before handing off the branch.',
                  payload: { nextJobId: jobId, branch: baseBranch, sha: checkpoint.sha },
                });
              } catch (error) {
                throw Object.assign(new Error(`Cannot safely checkpoint the previous stage before handoff: ${error instanceof Error ? error.message : String(error)}`), { code: 'workspace_setup_failed' });
              }
              dirty = await this.git(['status', '--porcelain'], { cwd: path });
            }
            if (dirty.code !== 0 || dirty.stdout.trim()) {
              throw Object.assign(new Error('The previous stage could not be made clean without discarding changes; inspect its worktree before handoff.'), { code: 'workspace_setup_failed' });
            }
            const detached = await this.git(['checkout', '--detach'], { cwd: path });
            if (detached.code !== 0) throw new Error(detached.stderr);
            const fresh = await this.git(['worktree', 'add', preferred, baseBranch], { cwd: repoRoot });
            if (fresh.code !== 0) throw new Error(fresh.stderr);
            await this.pool.query(`UPDATE executor.jobs SET metadata = metadata || $2::jsonb
              WHERE worktree_path = $1 AND id <> $3`, [path, JSON.stringify({ supersededBy: jobId }), jobId]);
            const tip = await this.git(['rev-parse', '--verify', `${baseBranch}^{commit}`], { cwd: repoRoot });
            if (tip.code !== 0) throw new Error(tip.stderr);
            return { branch: baseBranch, path: preferred, baseSha: tip.stdout.trim() };
          }
        }
      }
      throw Object.assign(
        new Error(`Attaching the worktree for "${baseBranch}" failed: ${(added.stderr || added.stdout).trim()}`),
        { code: 'workspace_setup_failed' },
      );
    }
    return { branch: baseBranch, path: preferred, baseSha: probe.stdout.trim() };
  }

  /**
   * Launch one job: resolve the repo, cut the worktree on a snapshot base
   * (or REUSE the previous attempt's branch on a retry), materialize
   * attachments (git-excluded), create the OpenCode session in the
   * worktree and send the composed prompt. Any failure lands the job in
   * `failed` (or re-queued when the retry budget allows) — the workspace
   * is left on disk either way (the retry resumes on it); workspaces are
   * only deleted by the hub's explicit merge op.
   */
  async launchJob(job: JobRow): Promise<void> {
    if (!this.client || this.launchingJobs.has(job.id)) return;
    if (this.launchingJobs.size >= this.config.maxParallelJobs) {
      await this.queueJob(job, 'Waiting for executor launch capacity.', 'capacity');
      return;
    }
    this.launchingJobs.add(job.id);
    // Dedicated connections keep long launches from exhausting the query pool.
    const owner = new Client(this.pool.options);
    let locked = false;
    try {
      await owner.connect();
      // Connection-scoped ownership releases automatically on process death.
      locked = (await owner.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [job.id])).rows[0]!.locked;
      if (!locked) return;
      await owner.query('BEGIN');
      await owner.query("SELECT pg_advisory_xact_lock(hashtextextended('executor-admission', 0))");
      // Serialize eligibility with cancel/terminal transitions, not only with
      // other admissions. No unconditional write may follow an unlocked read.
      const selected = await owner.query<DbJobRow>('SELECT * FROM executor.jobs WHERE id = $1 FOR UPDATE', [job.id]);
      const current = selected.rows[0] ? rowToJob(selected.rows[0]) : null;
      if (!current || !['created', 'queued'].includes(current.status) ||
          (current.retryBackoffUntil && current.retryBackoffUntil.getTime() > Date.now())) {
        await owner.query('COMMIT');
        return;
      }
      const count = await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM executor.jobs
        WHERE id <> $1 AND (status IN ('running', 'verifying') OR (status = 'created' AND started_at IS NOT NULL))`, [job.id]);
      if (count.rows[0]!.n >= this.config.maxParallelJobs) {
        await owner.query("UPDATE executor.jobs SET status = 'queued', started_at = NULL WHERE id = $1", [job.id]);
        const visible = await owner.query(`SELECT 1 FROM executor.job_events
          WHERE job_id = $1 AND event_type = $2 AND payload->>'reason' = 'capacity' LIMIT 1`,
        [job.id, EVENT.EXECUTION_STATUS_CHANGED]);
        if (!visible.rowCount) await appendJobEvent(owner, {
          jobId: job.id, eventType: EVENT.EXECUTION_STATUS_CHANGED,
          summary: 'Waiting for executor capacity.',
          payload: { status: 'queued', reason: 'capacity', maxParallelJobs: this.config.maxParallelJobs },
        });
        await owner.query('COMMIT');
        return;
      }
      await owner.query(`UPDATE executor.jobs SET status = 'created', started_at = COALESCE(started_at, NOW()),
        metadata = metadata || $2::jsonb, updated_at = NOW() WHERE id = $1`, [job.id, JSON.stringify({ launchToken: randomUUID() })]);
      await owner.query('COMMIT');
      job = (await getJobByHubId(owner, job.hubJobId))!;
      if (!await this.isCurrent(job)) return;
      this.armDeadline(job);
      await this.launchOwned(job, owner);
    } finally {
      await owner.query('ROLLBACK').catch(() => {});
      // Closing releases both ownership locks even after a broken connection.
      await owner.end();
      this.launchingJobs.delete(job.id);
    }
  }

  private async isCurrent(job: JobRow): Promise<boolean> {
    const current = await getJobByHubId(this.pool, job.hubJobId);
    return !!current && current.attemptCount === job.attemptCount &&
      (!job.metadata.launchToken || current.metadata.launchToken === job.metadata.launchToken) &&
      !TERMINAL_STATUSES.includes(current.status) && current.status !== 'queued';
  }

  private async promptCurrent(job: JobRow, sessionId: string, text: string) {
    if (!await this.isCurrent(job)) throw new AttemptInterrupted('Job no longer owns this attempt');
    await applyJobPermissions(this.pool, this.client, job.hubJobId, { sessionId, attempt: job.attemptCount });
    const sent = await this.client!.prompt(sessionId, text);
    if (!await this.isCurrent(job)) {
      // Covers cancellation racing the remote prompt request/response.
      await this.client!.interrupt(sessionId).catch(() => {});
      throw new AttemptInterrupted('Job interrupted during prompt dispatch');
    }
    return sent;
  }

  private armDeadline(job: JobRow): void {
    if (!job.startedAt || this.config.jobTimeoutMs <= 0) return;
    const previous = this.deadlines.get(job.id);
    if (previous?.attempt === job.attemptCount) return;
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      this.deadlines.delete(job.id);
      this.track((async () => {
        const current = await getJobByHubId(this.pool, job.hubJobId);
        if (current && current.attemptCount === job.attemptCount && ['created', 'running', 'verifying'].includes(current.status)) {
          if (await reconcileManualApprovals(this.pool,this.client,current.id)) return;
          const refreshed = (await getJobByHubId(this.pool,job.hubJobId))!;
          if (activeElapsed(refreshed,this.now()) < this.config.jobTimeoutMs) { this.armDeadline(refreshed); return; }
          await this.failJob(job.id, 'execution_timeout', 'Job timed out: exceeded its execution deadline.', { interrupt: true, expectedAttempt: job.attemptCount });
        }
      })());
    }, Math.max(1, this.config.jobTimeoutMs - activeElapsed(job,this.now())));
    timer.unref();
    this.deadlines.set(job.id, { attempt: job.attemptCount, timer });
  }

  private async runCommand(job: JobRow) {
    // Restart/manual verification can bypass launch entirely. Repair links
    // at the execution boundary as well, before Node sees ancestor deps.
    try {
      const repoRoot = typeof job.metadata.repoRoot === 'string' && job.metadata.repoRoot
        ? job.metadata.repoRoot : await this.resolveRepoRoot(job.spec);
      linkNodeModules(repoRoot, job.worktreePath);
    } catch (error) {
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: 'session_setup_failed' });
    }
    const controller = new AbortController();
    this.commands.set(job.id, controller);
    // Also observe cancellations issued by another executor process. Never
    // let an old command repair or finish a newer attempt.
    let checking = false;
    const watch = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.isCurrent(job).then((current) => { if (!current) controller.abort(); })
        .catch(() => controller.abort()).finally(() => { checking = false; });
    }, 250);
    this.armDeadline(job);
    try {
      const result = await runJobCommand(job.verificationCommand, job.worktreePath, jobEnv(), controller.signal);
      // Abort is never a verification failure eligible for a repair prompt.
      if (controller.signal.aborted) throw new AttemptInterrupted('Verification command cancelled');
      return result;
    } finally {
      clearInterval(watch);
      if (this.commands.get(job.id) === controller) this.commands.delete(job.id);
    }
  }

  private async prepareSession(job: JobRow): Promise<ModelRef | null> {
    const { spec, worktreePath } = job;
    if (spec.agent) {
      if (spec.agent.skills?.length) {
        try { await materializeJobSkills(this.git, worktreePath, spec.agent.skills); }
        catch (error) { throw Object.assign(new Error(String(error)), { code: 'workspace_setup_failed' }); }
      }
      try { await materializeJobAgent(this.git, worktreePath, spec.agent); }
      catch (error) { throw Object.assign(new Error(String(error)), { code: 'workspace_setup_failed' }); }
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.AGENT_APPLIED,
        summary: `Agent "${spec.agent.name}" materialized natively on the job worktree (${spec.agent.opencodeAgent}).`,
        payload: { agent: spec.agent.opencodeAgent, name: spec.agent.name, mcp: spec.agent.mcp ? 'written' : 'none', tier: 'native',
          skills: spec.agent.skills?.map(skill => ({ id: skill.id, sha256: skill.sha256 })) ?? [] },
      });
    }
    if (spec.modelPolicy && job.metadata.modelPolicyDir !== worktreePath) {
      let registration: { canary: string | null };
      try {
        await protectJobConfig(this.git, worktreePath, ['opencode.json']);
        registration = await registerModelPolicy(this.client!, worktreePath, spec.modelPolicy.providers);
      } catch (error) {
        throw Object.assign(new ModelPolicyError(String(error)), { code: 'model_policy_failed' });
      }
      await this.mergeMetadata(job.id, { modelPolicyDir: worktreePath });
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.MODEL_POLICY,
        summary: 'Model policy enforced on the job worktree.',
        payload: { providers: spec.modelPolicy.providers, models: spec.modelPolicy.models, canary: registration.canary, directory: worktreePath },
      });
    }
    const priority = (spec.models ?? []).map(parseModelRef).filter((entry): entry is ModelRef => entry !== null);
    const index = Math.min(Math.max(0, typeof job.metadata.modelIndex === 'number' ? job.metadata.modelIndex : 0), Math.max(0, priority.length - 1));
    const model = priority[index] ?? null;
    if (spec.modelPolicy && (!model || !spec.modelPolicy.providers.includes(model.providerID))) {
      throw Object.assign(new ModelPolicyError('The job model is absent or outside its model policy.'), { code: 'model_policy_failed' });
    }
    return model;
  }

  private async launchOwned(job: JobRow, owner: SqlExecutor): Promise<void> {
    const fromStatus = job.status;
    const isRetry = job.attemptCount > 1;
    const retryState = (job.metadata.retryState ?? null) as { code?: string; reason?: string; committed?: boolean } | null;
    let prepared: { branch: string; path: string; baseSha: string } | null = null;
    let repoRoot: string | null = null;
    try {
      const spec = job.spec;
      if (job.opencodeSessionId) {
        // Never duplicate a session/prompt after an ambiguous dispatch crash,
        // but older persisted workspaces still need dependency repair.
        repoRoot = typeof job.metadata.repoRoot === 'string' && job.metadata.repoRoot
          ? job.metadata.repoRoot : await this.resolveRepoRoot(spec);
        linkNodeModules(repoRoot, job.worktreePath);
        await this.pool.query("UPDATE executor.jobs SET status = 'running' WHERE id = $1 AND status = 'created' AND attempt_count = $2", [job.id, job.attemptCount]);
        return;
      }
      repoRoot = await this.resolveRepoRoot(spec);
      const baseRef = await resolveBaseRef(this.git, repoRoot, this.config.baseRef);
      if (!await this.isCurrent(job)) return;
      if (spec.baseBranch) {
        const common = await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot });
        if (common.code !== 0) throw new Error(common.stderr);
        const lock = await owner.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`branch:${common.stdout.trim()}:${spec.baseBranch}`]);
        if (!lock.rows[0]!.locked) {
          await this.queueJob(job, 'Waiting for the previous stage to finish launch.', 'branch_busy');
          return;
        }
      }
      if (job.branch) {
        prepared = await this.resumeWorkspace(repoRoot, job);
        if (prepared.path !== job.worktreePath) {
          await this.pool.query(
            `UPDATE executor.jobs SET worktree_path = $2, version = version + 1, updated_at = NOW()
             WHERE id = $1 AND status = $3`, [job.id, prepared.path, fromStatus]);
        }
      } else {
        prepared = spec.baseBranch
          // Pipeline stage: attach to the stage's named branch (spec §4) —
          // a branch is sacred, never silently re-cut.
          ? await this.attachNamedBranch(repoRoot, spec.baseBranch, job.id, owner)
          : await prepareWorktree(
            this.git,
            { repoRoot, worktreeRoot: join(this.config.workspaceRoot, 'worktrees') },
            { jobName: jobShortId(job.hubJobId) },
          );
        await this.pool.query(
          `UPDATE executor.jobs SET branch = $2, worktree_path = $3,
             metadata = metadata || $4::jsonb, version = version + 1, updated_at = NOW()
           WHERE id = $1 AND status = $5`, [
            job.id, prepared.branch, prepared.path,
            JSON.stringify({ repoRoot, baseRef, baseSha: prepared.baseSha }),
            fromStatus,
          ]);
        await appendJobEvent(this.pool, {
          jobId: job.id, eventType: EVENT.WORKTREE_CREATED,
          summary: `Worktree ${prepared.branch}`,
          payload: { branch: prepared.branch, path: prepared.path, baseSha: prepared.baseSha, baseRef, repoRoot },
        });
      }

      // Also covers retry reuse/reattachment and every named-stage path,
      // before verifyFirst or an agent can resolve ancestor executor deps.
      // Keep this AFTER persisting workspace identity: a broken installed
      // dependency must leave retries able to resume the existing branch.
      linkNodeModules(repoRoot, prepared.path);

      // Any fresh launch supersedes a rebase-repair state left by a
      // previous attempt (the retry re-attaches and replays the step).
      if (!await this.isCurrent(job)) return;
      if (job.metadata.pendingRebaseRepair === true) {
        await this.mergeMetadata(job.id, { pendingRebaseRepair: false, rebaseRounds: 0 });
      }

      // Pipeline stage (spec §4 rebaseFirst): pull the base ref BEFORE any
      // session/prompt. Conflicts open the lazy repair session and this
      // launch is DONE — the repair turn's end fold resumes the stage.
      if (spec.rebaseFirst && !isRetry) {
        const staged = {
          ...job,
          branch: prepared.branch,
          worktreePath: prepared.path,
          metadata: { ...job.metadata, repoRoot, baseRef, baseSha: prepared.baseSha },
        };
        const result = await this.pullBaseForJob(staged);
        if (result.outcome === 'repairing') return;
      }

      // Pipeline stage (spec §4 verifyFirst): run the verification BEFORE
      // any session/prompt exists. Pass ⇒ succeed with NO session ever
      // created; fail ⇒ fall through and open the session on the EXISTING
      // repair prompt — the standard repair loop takes it from there.
      let promptOverride: string | null = null;
      if (spec.verifyFirst && !isRetry) {
        const attempts = job.verificationAttemptCount + 1; // retry-inclusive
        await appendJobEvent(this.pool, {
          jobId: job.id, eventType: EVENT.VERIFICATION_STARTED,
          summary: `Running \`${job.verificationCommand}\``, payload: { command: job.verificationCommand },
        });
        const result = await this.runCommand({ ...job, worktreePath: prepared.path, metadata: { ...job.metadata, repoRoot } });
        if (!await this.isCurrent(job)) return;
        const verifyMeta = JSON.stringify({
          verification: { attempts, exitCode: result.code, outputTail: result.output.slice(-4000) },
        });
        await this.pool.query(
          `UPDATE executor.jobs SET verification_attempt_count = $2, metadata = metadata || $3::jsonb, updated_at = NOW()
           WHERE id = $1 AND status = $4`, [job.id, attempts, verifyMeta, fromStatus]);
        if (result.code === 0) {
          await appendJobEvent(this.pool, {
            jobId: job.id, eventType: EVENT.VERIFICATION_PASSED,
            summary: `Verification passed (attempt ${attempts}).`,
            payload: { attempt: attempts, command: job.verificationCommand, output: result.output },
          });
          await this.succeedJob(job, 'Verification passed before any agent turn.');
          return;
        }
        await appendJobEvent(this.pool, {
          jobId: job.id, eventType: EVENT.VERIFICATION_FAILED,
          summary: `Verification failed (attempt ${attempts}, exit ${result.code}).`,
          payload: { attempt: attempts, command: job.verificationCommand, exitCode: result.code, output: result.output },
        });
        promptOverride = repairPrompt(job.verificationCommand, result);
      }

      // Attachments: the git exclude goes in BEFORE any file lands. On a
      // retry they are re-materialized — a re-attached worktree lost the
      // git-excluded copies, and overwriting an existing one is cheap.
      const attachments = spec.attachments ?? [];
      let attachmentsDir = '';
      let attachmentFiles: Awaited<ReturnType<typeof materializeJobAttachments>>['files'] = [];
      if (attachments.length) {
        try {
          const decoded: AttachmentFile[] = attachments.map((attachment) => ({
            name: attachment.name,
            mimeType: attachment.mimeType,
            data: Buffer.from(attachment.dataBase64, 'base64'),
          }));
          const materialized = await materializeJobAttachments(this.git, prepared.path, decoded);
          attachmentsDir = materialized.dir;
          attachmentFiles = materialized.files;
        } catch (error) {
          throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { code: 'workspace_setup_failed' });
        }
      }

      const modelRef = await this.prepareSession({ ...job, worktreePath: prepared.path });
      const originalPrompt = await this.composePrompt(spec, attachmentsDir, attachmentFiles);
      const composed = promptOverride ? `${originalPrompt}\n\n${promptOverride}` : originalPrompt;
      const prompt = isRetry && !promptOverride
        ? [
            retryPreamble({
              attempt: job.attemptCount,
              maxAttempts: job.maxAttempts,
              errorCode: retryState?.code ?? job.errorCode ?? 'unknown',
              reason: retryState?.reason ?? job.failureReason ?? '',
              branchCommitted: retryState?.committed === true,
            }),
            composed,
          ].join('\n\n')
        : composed;
      if (!await this.isCurrent(job)) return;
      const session = await this.client!.createSession({
        title: job.title || `Job ${job.hubJobId}`,
        directory: prepared.path,
        // The materialized native persona rides the session pin (its own
        // frontmatter model/permission map); an absent persona keeps the
        // service's configured default agent.
        agent: spec.agent?.opencodeAgent ?? null,
        model: modelRef,
      });
      const modelEcho = session.model?.id
        ? `${session.model.providerID ?? ''}/${session.model.id}`
        : (modelRef ? `${modelRef.providerID}/${modelRef.modelID}` : '');
      if (!await this.isCurrent(job)) {
        await this.client!.interrupt(session.id).catch(() => {});
        return;
      }
      await this.pool.query(
        `UPDATE executor.jobs SET opencode_session_id = $2, model = $3,
           retry_backoff_until = NULL, metadata = metadata - 'retryState',
           version = version + 1, updated_at = NOW()
         WHERE id = $1 AND status = $4`, [job.id, session.id, modelEcho, fromStatus]);
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.SESSION_CREATED,
        summary: `OpenCode session ${session.id}`,
        payload: { sessionId: session.id, directory: prepared.path, model: modelEcho },
      });
      if (isRetry) {
        await appendJobEvent(this.pool, {
          jobId: job.id, eventType: EVENT.AUTO_RETRY_STARTED,
          summary: `Retry attempt ${job.attemptCount} of ${job.maxAttempts} launched (continues the same branch).`,
          payload: {
            attempt: job.attemptCount, maxAttempts: job.maxAttempts, model: modelEcho,
            previousCode: retryState?.code ?? null,
          },
        });
      }

      if (!await this.isCurrent(job)) return;
      const sent = await this.promptCurrent(job, session.id, prompt);
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.PROMPT_SENT,
        summary: prompt.slice(0, SUMMARY_LIMIT), payload: { text: prompt, promptMessageId: sent.id },
      });
      await this.pool.query(`
        UPDATE executor.jobs SET status = 'running', started_at = COALESCE(started_at, NOW()),
          version = version + 1, updated_at = NOW()
        WHERE id = $1 AND status = $2`, [job.id, fromStatus]);
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.EXECUTION_STATUS_CHANGED, summary: 'Job launched.',
      });
    } catch (error) {
      const rawCode = (error as { code?: string }).code;
      if (error instanceof AttemptInterrupted) return;
      if (!await this.isCurrent(job)) return;
      const code = rawCode === 'workspace_setup_failed' || rawCode === 'model_policy_failed'
        ? rawCode : 'session_setup_failed';
      await this.failAttempt(job, code, error instanceof Error ? error.message : String(error), { interrupt: false });
      // The workspace is NEVER removed here. The engine performs no
      // implicit deletion: a failed attempt's branch and worktree stay on
      // disk so the retry resumes them (deleting the first attempt's
      // workspace used to strand every later attempt on a dead branch).
      // The ONLY deletion path is the hub's explicit merge op below.
    }
  }



  /** stored systemPrompt → project.customPrompt → the job prompt → the
   *  attachment listing ("### Attached files" — content is never inlined). */
  private async composePrompt(
    spec: JobSpecInput,
    attachmentsDir: string,
    attachments: readonly { name: string; path: string; mimeType: string; byteSize: number }[],
  ): Promise<string> {
    const parts: string[] = [];
    const { rows } = await this.pool.query<{ value: unknown }>(
      `SELECT value FROM executor.config WHERE key = 'systemPrompt'`);
    const stored = rows[0]?.value;
    if (typeof stored === 'string' && stored.trim()) parts.push(stored.trim());
    if (spec.project?.customPrompt?.trim()) parts.push(spec.project.customPrompt.trim());
    parts.push(spec.prompt);
    if (attachments.length) {
      parts.push(
        [
          '### Attached files',
          '',
          `The user attached ${attachments.length} file${attachments.length === 1 ? '' : 's'} for this task. They are in \`${attachmentsDir}\` — read them with your file tools and work from their actual content:`,
          ...attachments.map((file) => `- \`${file.path}\` — ${file.mimeType || 'unknown type'}, ${file.byteSize} bytes`),
          '',
          'These files are excluded from git: never commit, merge or deploy them.',
        ].join('\n'),
      );
    }
    return parts.join('\n\n');
  }

  /* ── Poll ──────────────────────────────────────────────────────────── */

  /** One worker sweep: admit, poll active sessions, sweep verification timeouts. */
  async tick(): Promise<void> {
    // Arm ALL deadlines before any external I/O; a hung messages request or
    // repeated fallback cannot prevent another job's deadline from firing.
    const active = await this.pool.query<DbJobRow>(`SELECT * FROM executor.jobs
      WHERE status IN ('created', 'running', 'verifying') AND started_at IS NOT NULL`);
    for (const raw of active.rows) this.armDeadline(rowToJob(raw));
    await this.admitQueued().catch((error) => this.onError(error));
    const { rows } = await this.pool.query<DbJobRow>(`
      SELECT * FROM executor.jobs
      WHERE status IN ('running', 'waiting_for_user') AND opencode_session_id IS NOT NULL
      ORDER BY updated_at ASC LIMIT 50`);
    for (const raw of rows) {
      const job = rowToJob(raw);
      await this.pollJob(job).catch((error) => this.onError(this.jobError(job, 'poll', error)));
    }
    // `verifying` jobs run detached — a restart loses the detached promise
    // but never the row. Re-adopt every verifying job whose cycle is not
    // running in THIS process; the timeout sweep below still bounds the
    // pathological case.
    const { rows: verifying } = await this.pool.query<DbJobRow>(`
      SELECT * FROM executor.jobs WHERE status = 'verifying' ORDER BY updated_at ASC LIMIT 25`);
    for (const raw of verifying) {
      const job = rowToJob(raw);
      if (this.verifyingJobs.has(job.id)) continue;
      if (!job.worktreePath || !existsSync(job.worktreePath)) {
        await this.failAttempt(job, 'verification_failed',
          'The job workspace is gone — the verification cycle cannot resume.').catch((error) => this.onError(error));
        continue;
      }
      this.track(this.runVerification(job));
    }
    // `verifying` jobs run detached; the timeout still bounds them.
    if (this.config.jobTimeoutMs > 0) {
      const { rows: stuck } = await this.pool.query<DbJobRow>(`
        SELECT * FROM executor.jobs
        WHERE status IN ('created', 'running', 'verifying') AND started_at IS NOT NULL
          AND started_at < NOW() - ($1 || ' milliseconds')::interval`,
        [String(this.config.jobTimeoutMs)]);
      for (const raw of stuck) {
        const job = rowToJob(raw);
        if (await reconcileManualApprovals(this.pool,this.client,job.id)) continue;
        const refreshed = (await getJobByHubId(this.pool,job.hubJobId))!;
        if (activeElapsed(refreshed,this.now()) < this.config.jobTimeoutMs) continue;
        await this.interruptSession(job);
        await this.failAttempt(job, 'execution_timeout',
          `Job timed out after ${Math.round(this.config.jobTimeoutMs / 60_000)} minutes.`);
      }
    }
    await this.sweepTerminalWorkspaces().catch((error) => this.onError(error));
  }

  async pollJob(job: JobRow): Promise<void> {
    const owner = new Client(this.pool.options);
    try {
      await owner.connect();
      const lock = await owner.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [job.id]);
      if (!lock.rows[0]!.locked || !await this.isCurrent(job)) return;
      const current = await getJobByHubId(owner, job.hubJobId);
      if (current && ['running', 'waiting_for_user'].includes(current.status)) await this.pollOwned(current);
    } finally { await owner.end(); }
  }

  private async pollOwned(job: JobRow): Promise<void> {
    await applyJobPermissions(this.pool, this.client, job.hubJobId);
    // Persist waits BEFORE deadlines, message folding, plan gates or watchdogs.
    const wasWaiting = typeof job.metadata.permissionWaitStartedAt === 'number';
    const waiting = await reconcileManualApprovals(this.pool,this.client,job.id);
    const refreshed = await getJobByHubId(this.pool,job.hubJobId);
    if (refreshed) job = refreshed;
    if (waiting) {
      // Approval waiting suspends clocks, not the existing recovery verdict
      // for a vanished workspace. Never keep a dead tool looking resumable.
      if (job.worktreePath && !existsSync(job.worktreePath)) {
        await this.failMissingWorkspace(job);
        return;
      }
      if (!wasWaiting) await appendJobEvent(this.pool,{ jobId:job.id,eventType:'PERMISSION_REQUESTED',summary:'Waiting for the run owner to decide a tool permission.',payload:{ attempt:job.attemptCount,sessionId:job.opencodeSessionId } });
      return;
    }
    this.armDeadline(job);
    if (job.status !== 'waiting_for_user' && job.startedAt && this.config.jobTimeoutMs > 0 &&
        activeElapsed(job,this.now()) >= this.config.jobTimeoutMs) {
      await this.failAttempt(job, 'execution_timeout', 'Job timed out: exceeded its execution deadline.');
      return;
    }
    // Parked jobs have no deadline. A lost workspace must not be hidden by a
    // forgotten/unreachable session (especially a messages 404).
    if (job.status === 'waiting_for_user' && job.worktreePath && !existsSync(job.worktreePath)) {
      await this.failMissingWorkspace(job);
      return;
    }
    if (!this.client || !job.opencodeSessionId) return;
    let messages: OpenCodeMessage[];
    try {
      messages = await this.client.getMessages(job.opencodeSessionId);
    } catch (error) {
      if (job.worktreePath && !existsSync(job.worktreePath)) {
        await this.failMissingWorkspace(job);
        return;
      }
      // A session the service 404s is not this worker's to poll — after a
      // restart the service may simply have forgotten it. The job timeout
      // still bounds the row.
      if (error instanceof OpenCodeError && error.status === 404) return;
      throw error;
    }

    // Fold only NEW events; the V2 list arrives newest-first, so walk it
    // oldest-first for chronological sequence numbers. Seen message ids
    // persist in job metadata (capped) — the poll never re-folds.
    const seen = new Set(asStringArray(job.metadata.seenMessageIds));
    const captured: string[] = [];
    for (const event of [...messages].reverse().flatMap((message) => messageToEvents(message))) {
      if (seen.has(event.opencodeMessageId)) continue;
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: event.eventType, source: 'opencode',
        summary: event.summary, payload: event.payload, messageId: event.opencodeMessageId,
      });
      captured.push(event.opencodeMessageId);
    }
    if (captured.length) {
      await this.mergeMetadata(job.id, { seenMessageIds: [...seen, ...captured].slice(-SEEN_IDS_CAP) });
    }

    if (!job.model) {
      const assistant = messages.find((message) => message.type === 'assistant');
      const model = assistant?.model?.id ? `${assistant.model.providerID ?? ''}/${assistant.model.id}` : '';
      if (model) {
        await this.pool.query(`UPDATE executor.jobs SET model = $2, updated_at = NOW() WHERE id = $1 AND model = ''`, [job.id, model]);
        job = { ...job, model };
      }
    }

    const last = currentTurnResult(messages);
    const complete = last ? messageComplete(last) : false;
    const meta = job.metadata;
    const now = this.now();

    if (complete && last && job.status === 'running') {
      if (turnErrored(last)) {
        // An errored turn already handled by a model fallback: the
        // continuation prompt is in flight but the errored message is still
        // the newest assistant row — re-polled, it must NOT fail the job.
        // (The hub gets this from its intermediate agent_finished state.)
        const user = [...messages].filter((message) => message.type === 'user')
          .sort(compareMessageOrder).at(-1);
        if (job.metadata.lastFallbackMessageId === last.id ||
            (user && job.metadata.lastFallbackUserMessageId === user.id)) return;
        // Usage-limit and provider 401/403 errors walk the agent's chain IN the session —
        // the conversation carries the whole task, the next model continues.
        // Only an exhausted chain (or an ineligible error) fails the job.
        const fell = await this.maybeModelFallback(job, last, user?.id).catch((error) => {
          this.onError(this.jobError(job, 'model_fallback', error));
          return false;
        });
        if (fell) return;
        // A provider-policy denial (provider.no-route): the worktree's own
        // model fence refused the turn's model BEFORE any provider call.
        // Deterministic — no fallback, no in-job retry; the agent's model
        // chain is where the fix lives (hub-side).
        if (isModelPolicyDenial(last.error)) {
          await this.interruptSession(job);
          await appendJobEvent(this.pool, {
            jobId: job.id, eventType: EVENT.MODEL_POLICY_BLOCKED,
            summary: agentErrorSummary(last.error ?? 'provider policy denied the model'),
            payload: { reason: agentErrorSummary(last.error ?? 'provider policy denied the model') },
          });
          await this.failAttempt(
            job, 'model_policy_blocked',
            `The job's model policy blocked the agent's turn: ${agentErrorSummary(last.error ?? { message: last.finish ?? 'unknown error' })}. Only the assigned agents' own model chains may run — the fix belongs on the agent's models hub-side.`,
            { interrupt: false },
          );
          return;
        }
        await this.interruptSession(job);
        await this.failAttempt(job, 'agent_error', agentErrorSummary(last.error ?? { message: last.finish ?? 'unknown error' }), { interrupt: false });
        return;
      }
    }

    // Workspace loss is a durable, non-retryable verdict, not a git spawn
    // failure. Check even previously processed waiting turns; never recreate
    // a branch or claim its uncommitted contents were saved. Provider failure
    // handling above must not depend on this optional checkpoint succeeding.
    if (job.worktreePath && !existsSync(job.worktreePath)) {
      await this.failMissingWorkspace(job);
      return;
    }
    if (complete && last && job.worktreePath && meta.lastCheckpointMessageId !== last.id) {
      try {
        await commitJobChanges(this.git, { path: job.worktreePath, message: 'executor: checkpoint after agent turn' });
      } catch (error) {
        const contextual = this.jobError(job, 'checkpoint', error);
        this.onError(contextual);
        await appendJobEvent(this.pool, {
          jobId: job.id, eventType: EVENT.WORKTREE_CHECKPOINT_FAILED,
          summary: contextual.message,
          payload: { jobId: job.id, operation: 'checkpoint', workspacePath: job.worktreePath, error: String(error) },
        });
      }
      // Record the attempt, not a fictitious successful checkpoint. Transient
      // git errors stay visible without retrying every parked poll.
      await this.mergeMetadata(job.id, { lastCheckpointMessageId: last.id });
    }

    if (complete && last && job.status === 'running') {
      if (asksUserForInput(last)) {
        if (last.id !== meta.lastAskedMessageId) {
          const text = finalAssistantText(last);
          await this.mergeMetadata(job.id, { lastAskedMessageId: last.id });
          await this.pool.query(
            `UPDATE executor.jobs SET status = 'waiting_for_user', version = version + 1, updated_at = NOW()
             WHERE id = $1 AND status = 'running'`, [job.id]);
          await appendJobEvent(this.pool, {
            jobId: job.id, eventType: EVENT.AGENT_ASKED_USER,
            summary: text.slice(0, SUMMARY_LIMIT), payload: { text },
          });
        }
        return;
      }
      // Rebase-repair continuation (spec §4): the repair turn ended. Clean
      // worktree ⇒ complete the merge and continue the stage (verify loop
      // or success); still conflicted ⇒ re-prompt, bounded, then failed.
      if (job.metadata.pendingRebaseRepair === true && last.id !== meta.lastRepairFoldMessageId) {
        await this.mergeMetadata(job.id, { lastRepairFoldMessageId: last.id });
        const baseRef = typeof job.metadata.rebaseBaseRef === 'string' && job.metadata.rebaseBaseRef
          ? job.metadata.rebaseBaseRef
          : (typeof job.metadata.baseRef === 'string' ? job.metadata.baseRef : '');
        const unmerged = await listUnmergedPaths(this.git, job.worktreePath);
        if (unmerged.length === 0) {
          const mergeSha = await completeWorktreeMerge(this.git, job.worktreePath);
          await this.mergeMetadata(job.id, { pendingRebaseRepair: false, rebaseRounds: 0 });
          await appendJobEvent(this.pool, {
            jobId: job.id, eventType: EVENT.REBASE_MERGED,
            summary: `Rebase conflicts resolved — merge completed (${mergeSha.slice(0, 12)}).`,
            payload: { baseRef, mergeSha, resolved: true },
          });
          if (job.verificationCommand) {
            const stamped = await this.pool.query(
              `UPDATE executor.jobs SET status = 'verifying', version = version + 1, updated_at = NOW()
               WHERE id = $1 AND status = 'running'`, [job.id]);
            if (stamped.rowCount) {
              const fresh = (await getJobByHubId(this.pool, job.hubJobId))!;
              await appendJobEvent(this.pool, {
                jobId: job.id, eventType: EVENT.VERIFICATION_STARTED,
                summary: `Running \`${job.verificationCommand}\``, payload: { command: job.verificationCommand },
              });
              this.track(this.runVerification(fresh));
            }
          } else {
            await this.succeedJob(job, finalAssistantText(last));
          }
        } else {
          const rounds = (typeof job.metadata.rebaseRounds === 'number' ? job.metadata.rebaseRounds : 0) + 1;
          await this.mergeMetadata(job.id, { rebaseRounds: rounds });
          if (rounds >= MAX_REBASE_ROUNDS) {
            await appendJobEvent(this.pool, {
              jobId: job.id, eventType: EVENT.REBASE_FAILED,
              summary: `Rebase conflicts remain after ${rounds} repair rounds: ${unmerged.join(', ')}.`,
              payload: { baseRef, conflicts: unmerged, rounds },
            });
            await this.failAttempt(
              job, 'merge_conflict',
              `Pulling ${baseRef} into the worktree still conflicts after ${rounds} repair round(s): ${unmerged.join(', ')}`,
              { interrupt: false },
            );
          } else {
            const text = rebaseConflictPrompt(unmerged, baseRef);
            await this.promptCurrent(job, job.opencodeSessionId!, text);
            await appendJobEvent(this.pool, {
              jobId: job.id, eventType: EVENT.REPAIR_REQUESTED,
              summary: `Rebase conflict repair, round ${rounds + 1}.`,
              payload: { attempt: rounds, text, reason: 'rebase_conflicts', baseRef },
            });
          }
        }
        return;
      }
      if (last.id !== meta.lastPromotedMessageId) {
        // Pipeline plan-gate (spec §4 parkOnTurnEnd): park instead of
        // promoting — summary captured, waiting_for_user; a hub message
        // resumes the session and the NEXT turn end parks again.
        if (job.spec.parkOnTurnEnd) {
          await this.mergeMetadata(job.id, { lastPromotedMessageId: last.id });
          const text = finalAssistantText(last);
          // The hub consumes this as the full plan, not a timeline preview.
          // Only event summaries should be capped by SUMMARY_LIMIT.
          const parked = await this.pool.query(
            `UPDATE executor.jobs SET status = 'waiting_for_user', summary = $2, version = version + 1, updated_at = NOW()
             WHERE id = $1 AND status = 'running'`, [job.id, text]);
          if (parked.rowCount) {
            await appendJobEvent(this.pool, {
              jobId: job.id, eventType: EVENT.EXECUTION_STATUS_CHANGED,
              summary: 'Turn ended — stage parked for approval.',
              payload: { reason: 'stage_gate', summary: text },
            });
          }
          return;
        }
        if (!job.verificationCommand) {
          await this.mergeMetadata(job.id, { lastPromotedMessageId: last.id });
          await this.succeedJob(job, finalAssistantText(last));
          return;
        }
        if (last.id !== meta.lastVerifiedMessageId) {
          const stamped = await this.pool.query(
            `UPDATE executor.jobs SET status = 'verifying', version = version + 1,
               metadata = metadata || $2::jsonb, updated_at = NOW()
             WHERE id = $1 AND status = 'running'`,
            [job.id, JSON.stringify({ lastPromotedMessageId: last.id, lastVerifiedMessageId: last.id })]);
          if (stamped.rowCount) {
            const fresh = (await getJobByHubId(this.pool, job.hubJobId))!;
            await appendJobEvent(this.pool, {
              jobId: job.id, eventType: EVENT.VERIFICATION_STARTED,
              summary: `Running \`${job.verificationCommand}\``, payload: { command: job.verificationCommand },
            });
            this.track(this.runVerification(fresh));
          }
          return;
        }
      }
    }

    if (job.status === 'running') {
      // Answer any permission approvals FIRST: an `ask` nobody answers is a
      // wedge that looks exactly like a lost tool dispatch (see the drain's
      // doc comment), and rejecting it unblocks the turn within one tick.
      // When something was rejected the tool state just changed under this
      // tick's message snapshot — judge health on the NEXT tick, never fail
      // the run on the stale view of a turn we just unstuck.
      if (!job.spec.manualApprovals && await this.rejectPendingPermissions(job) > 0) return;
      const resumedAt = Number(job.metadata.permissionResumedAt ?? 0);
      const healthMessages = resumedAt > 0 ? messages.map(message => ({ ...message,
        time:{ ...message.time,created:Math.max(message.time?.created ?? 0,resumedAt) },
        content:message.content?.map(part => {
          if (part.type !== 'tool') return part;
          const tool = part as OpenCodeToolPart;
          return { ...tool,time:{ ...tool.time,ran:Math.max(tool.time?.ran ?? message.time?.created ?? 0,resumedAt) } };
        }),
      })) : messages;
      const stalled = detectStall(healthMessages, {
        now, toolStallMs: this.config.toolStallMs, silenceStallMs: this.config.silenceStallMs,
      });
      const progress = stalled
        ? { store: readToolFingerprints(meta), stalled: null }
        : evaluateToolProgress(collectToolProgress(healthMessages), readToolFingerprints(meta), {
          now, toolProgressMs: this.config.toolProgressMs,
        });
      await this.mergeMetadata(job.id, { toolFingerprints: progress.store });
      const found = stalled ?? progress.stalled;
      if (found) {
        const interrupted = await this.interruptSession(job);
        await this.failAttempt(job, 'agent_stalled', stallFailureReason(found.summary, interrupted), { interrupt: false });
        return;
      }
      if (this.config.jobTimeoutMs > 0 && job.startedAt && activeElapsed(job,now) >= this.config.jobTimeoutMs) {
        await this.interruptSession(job);
        await this.failAttempt(job, 'execution_timeout',
          `Job timed out after ${Math.round(this.config.jobTimeoutMs / 60_000)} minutes.`, { interrupt: false });
      }
    }
  }

  /**
   * Automatic model fallback: when a completed turn ended in a usage-limit or provider auth
   * error and the job's model priority list still has a next entry, switch
   * the session to it and re-enter the SAME conversation instead of
   * failing. Returns false when the error is ineligible, no model is left,
   * or this errored turn was already handled (one fallback per turn — the
   * worker's next poll then fails the job, where the in-job retry budget
   * applies). Mirrors the hub's fallbackForModelLimit.
   */
  private async maybeModelFallback(job: JobRow, message: OpenCodeMessage, userMessageId?: string): Promise<boolean> {
    if (!this.client || !job.opencodeSessionId) return false;
    const error: OpenCodeMessageError = message.error ?? { message: message.finish ?? '' };
    if (!isModelFallbackError(error)) return false;
    const meta = job.metadata;
    if (meta.lastFallbackMessageId === message.id) return false;
    const priority = (job.spec.models ?? [])
      .map((entry) => parseModelRef(entry))
      .filter((entry): entry is ModelRef => entry !== null);
    const modelIndex = Math.min(
      Math.max(0, typeof meta.modelIndex === 'number' ? meta.modelIndex : 0),
      Math.max(0, priority.length - 1),
    );
    const next = priority[modelIndex + 1];
    if (!next) return false;
    const previous = priority[modelIndex] ?? null;
    const previousName = previous ? `${previous.providerID}/${previous.modelID}` : (job.model || null);
    const nextName = `${next.providerID}/${next.modelID}`;
    const prompt = fallbackPrompt(previousName, nextName, error);

    await this.client.switchModel(job.opencodeSessionId, next);
    const sent = await this.promptCurrent(job, job.opencodeSessionId, prompt);
    await this.mergeMetadata(job.id, {
      modelIndex: modelIndex + 1,
      lastFallbackMessageId: message.id,
      lastFallbackUserMessageId: userMessageId ?? null,
    });
    await this.pool.query(
      `UPDATE executor.jobs SET model = $2, updated_at = NOW() WHERE id = $1`, [job.id, nextName]);
    await appendJobEvent(this.pool, {
      jobId: job.id, eventType: EVENT.MODEL_FALLBACK,
      summary: `Model fallback after a provider error: ${previousName ?? 'the previous model'} → ${nextName}.`,
      payload: { from: previousName, to: nextName, reason: agentErrorSummary(error) },
    });
    await appendJobEvent(this.pool, {
      jobId: job.id, eventType: EVENT.PROMPT_SENT,
      summary: 'Continuation prompt sent after the model fallback.',
      payload: { text: prompt, promptMessageId: sent.id },
    });
    return true;
  }

  private jobError(job: JobRow, operation: string, cause: unknown): Error & { jobId: string; operation: string; workspacePath: string } {
    return Object.assign(new Error(`Job ${job.id} ${operation} (${job.worktreePath}): ${String(cause)}`, { cause }), {
      jobId: job.id, operation, workspacePath: job.worktreePath,
    });
  }

  private async failMissingWorkspace(job: JobRow): Promise<void> {
    await this.failAttempt(job, 'workspace_missing',
      `Job ${job.id}: checkpoint cannot use missing workspace ${job.worktreePath}. Restore the workspace/branch and retry, or cancel the job; uncommitted work cannot be checkpointed.`);
  }

  /* ── Verification ──────────────────────────────────────────────────── */

  /**
   * One detached verification cycle (the job is already `verifying`). Pass
   * → succeeded with the agent's closing summary; fail → a repair prompt
   * into the SAME session while attempts remain, else
   * `failed`/`verification_failed`. Every status write is guarded on
   * `status='verifying'` so a concurrent cancel wins.
   */
  /* ── Base pulls: rebaseFirst stage branch + the job.rebase op (spec §3.2/§4) ── */

  /** Merge the recorded base ref into the job's live worktree. Clean ⇒
   *  REBASE_CLEAN/REBASE_MERGED recorded; conflicts ⇒ REBASE_CONFLICTS + a
   *  lazy repair session. Returns the full outcome (the op maps it 1:1). */
  private async pullBaseForJob(job: JobRow): Promise<{ outcome: 'clean' | 'merged' | 'repairing'; conflicts: string[]; mergeSha: string | null }> {
    const repoRoot = typeof job.metadata.repoRoot === 'string' ? job.metadata.repoRoot : '';
    const baseRef = typeof job.metadata.baseRef === 'string' && job.metadata.baseRef.trim()
      ? job.metadata.baseRef : await resolveBaseRef(this.git, repoRoot, this.config.baseRef);
    const outcome = await pullBaseIntoWorktree(this.git, { repoRoot, worktreePath: job.worktreePath, baseRef });
    if (outcome.status === 'conflicts') {
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.REBASE_CONFLICTS,
        summary: `Pulling ${baseRef} into the worktree conflicts: ${outcome.conflicts.slice(0, 5).join(', ')}${outcome.conflicts.length > 5 ? ` (+${outcome.conflicts.length - 5} more)` : ''}.`,
        payload: { baseRef, conflicts: outcome.conflicts },
      });
      await this.mergeMetadata(job.id, { pendingRebaseRepair: true, rebaseRounds: 0, rebaseBaseRef: baseRef });
      await this.launchRebaseRepair(job, baseRef, outcome.conflicts);
      return { outcome: 'repairing', conflicts: outcome.conflicts, mergeSha: null };
    }
    if (outcome.status === 'merged') {
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.REBASE_MERGED,
        summary: `Pulled ${baseRef} into the worktree (${outcome.mergeSha!.slice(0, 12)}).`,
        payload: { baseRef, mergeSha: outcome.mergeSha },
      });
      return { outcome: 'merged', conflicts: [], mergeSha: outcome.mergeSha };
    }
    await appendJobEvent(this.pool, {
      jobId: job.id, eventType: EVENT.REBASE_CLEAN,
      summary: `The worktree is already up to date with ${baseRef}.`, payload: { baseRef },
    });
    return { outcome: 'clean', conflicts: [], mergeSha: null };
  }

  /** Prompt the conflict-resolution turn: reuse the job's session when it
   *  has one (mid-pipeline rebase), lazily CREATE one otherwise (a
   *  rebaseFirst stage job or a rerun started sessionless). */
  private async launchRebaseRepair(job: JobRow, baseRef: string, conflicts: string[]): Promise<void> {
    if (!this.client) {
      throw new EngineError(503, 'OpenCode is not configured on this executor — cannot repair rebase conflicts.');
    }
    const repair = rebaseConflictPrompt(conflicts, baseRef);
    const text = job.opencodeSessionId ? repair : `${await this.composePrompt(job.spec, '', [])}\n\n${repair}`;
    let sessionId = job.opencodeSessionId;
    if (!sessionId) {
      const model = await this.prepareSession(job);
      if (!await this.isCurrent(job)) return;
      const session = await this.client.createSession({
        title: job.title || `Job ${job.hubJobId}`,
        directory: job.worktreePath,
        agent: job.spec.agent?.opencodeAgent ?? null,
        model,
      });
      sessionId = session.id;
      await this.pool.query(
        `UPDATE executor.jobs SET opencode_session_id = $2, model = $4, version = version + 1, updated_at = NOW()
         WHERE id = $1 AND status IN ('created', 'running', 'waiting_for_user') AND attempt_count = $3`,
        [job.id, sessionId, job.attemptCount, model ? `${model.providerID}/${model.modelID}` : '']);
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.SESSION_CREATED,
        summary: `Session ${sessionId} (rebase repair)`,
        payload: { sessionId, directory: job.worktreePath, model: job.model, reason: 'rebase_repair' },
      });
    }
    if (!await this.isCurrent(job)) {
      await this.client.interrupt(sessionId).catch(() => {});
      return;
    }
    const sent = await this.promptCurrent(job, sessionId, text);
    await appendJobEvent(this.pool, {
      jobId: job.id, eventType: EVENT.REPAIR_REQUESTED,
      summary: 'Rebase conflict resolution requested.',
      payload: { attempt: 0, text, promptMessageId: sent.id, reason: 'rebase_conflicts', baseRef },
    });
    await this.pool.query(`
      UPDATE executor.jobs SET status = 'running', started_at = COALESCE(started_at, NOW()),
        version = version + 1, updated_at = NOW()
      WHERE id = $1 AND status IN ('created', 'waiting_for_user') AND attempt_count = $2`, [job.id, job.attemptCount]);
    await appendJobEvent(this.pool, {
      jobId: job.id, eventType: EVENT.EXECUTION_STATUS_CHANGED, summary: 'Rebase conflict repair running.',
    });
  }

  /** job.rebase: pull the base ref into the job's live worktree on demand
   *  (the pre-review freshness check / rebase retriggers). */
  async rebaseJob(hubJobId: string): Promise<{ status: 'up_to_date' | 'merged' | 'conflicts_repairing'; conflicts?: string[]; mergeSha?: string }> {
    const job = await getJobByHubId(this.pool, hubJobId);
    if (!job) throw new EngineError(404, `Unknown job ${hubJobId}.`);
    if (job.metadata.supersededBy) throw new EngineError(409, 'This stage handed its branch to a newer stage.');
    if (!job.worktreePath || !existsSync(job.worktreePath) || TERMINAL_STATUSES.includes(job.status)) {
      throw new EngineError(409, `Job ${hubJobId} has no live worktree — re-dispatch the rebase stage with rebaseFirst instead.`);
    }
    if (job.metadata.pendingRebaseRepair === true) {
      return { status: 'conflicts_repairing' }; // a repair turn is already running
    }
    const result = await this.pullBaseForJob(job);
    if (result.outcome === 'repairing') {
      return { status: 'conflicts_repairing', conflicts: result.conflicts };
    }
    return result.outcome === 'merged'
      ? { status: 'merged', ...(result.mergeSha ? { mergeSha: result.mergeSha } : {}) }
      : { status: 'up_to_date' };
  }

  private async runVerification(job: JobRow): Promise<void> {
    if (this.verifyingJobs.has(job.id)) return;
    this.verifyingJobs.add(job.id);
    const owner = new Client(this.pool.options);
    try {
      await owner.connect();
      // A poll may have just dispatched this detached cycle while still
      // holding ownership. Wait for it, then re-read the durable state.
      await owner.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [job.id]);
      const current = await getJobByHubId(owner, job.hubJobId);
      if (!current || current.status !== 'verifying' || current.attemptCount !== job.attemptCount) return;
      const attempts = job.verificationAttemptCount + 1;
      const result = await this.runCommand(job);
      if (!await this.isCurrent(job)) return;
      const meta = JSON.stringify({
        verification: { attempts, exitCode: result.code, outputTail: result.output.slice(-4000) },
      });
      if (result.code === 0) {
        await appendJobEvent(this.pool, {
          jobId: job.id, eventType: EVENT.VERIFICATION_PASSED,
          summary: `Verification passed (attempt ${attempts}).`,
          payload: { attempt: attempts, command: job.verificationCommand, output: result.output },
        });
        await this.pool.query(
          `UPDATE executor.jobs SET verification_attempt_count = $2, metadata = metadata || $3::jsonb, updated_at = NOW()
           WHERE id = $1 AND status = 'verifying' AND attempt_count = $4`, [job.id, attempts, meta, job.attemptCount]);
        let summary = '';
        try {
          const fresh = await this.client!.getMessages(job.opencodeSessionId!);
          const assistant = lastAssistant(fresh);
          summary = assistant ? finalAssistantText(assistant) : '';
        } catch { /* the summary is cosmetic */ }
        await this.succeedJob(job, summary);
        return;
      }
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.VERIFICATION_FAILED,
        summary: `Verification failed (attempt ${attempts}, exit ${result.code}).`,
        payload: { attempt: attempts, command: job.verificationCommand, exitCode: result.code, output: result.output },
      });
      const { rowCount } = await this.pool.query(
        `UPDATE executor.jobs SET verification_attempt_count = $2, metadata = metadata || $3::jsonb, updated_at = NOW()
         WHERE id = $1 AND status = 'verifying' AND attempt_count = $4`, [job.id, attempts, meta, job.attemptCount]);
      if (!rowCount) return;
      if (attempts < MAX_VERIFICATION_ATTEMPTS) {
        if (!await this.isCurrent(job)) return;
        const repair = repairPrompt(job.verificationCommand, result);
        try {
          await this.promptCurrent(job, job.opencodeSessionId!, repair);
        } catch (error) {
          await this.failAttempt(job, 'agent_error',
            `The repair prompt could not be sent: ${error instanceof Error ? error.message : String(error)}`, { interrupt: false });
          return;
        }
        await appendJobEvent(this.pool, {
          jobId: job.id, eventType: EVENT.REPAIR_REQUESTED,
          summary: `Repair attempt ${attempts + 1}`, payload: { attempt: attempts, text: repair },
        });
        await this.pool.query(
          `UPDATE executor.jobs SET status = 'running', version = version + 1, updated_at = NOW()
           WHERE id = $1 AND status = 'verifying' AND attempt_count = $2`, [job.id, job.attemptCount]);
      } else {
        await this.failAttempt(job, 'verification_failed',
          `Verification failed ${attempts} times. Last exit code ${result.code}. Output tail: ${result.output.slice(-2000)}`,
          { interrupt: false });
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'session_setup_failed') {
        await this.failAttempt(job, 'session_setup_failed', error instanceof Error ? error.message : String(error), { interrupt: false });
        return;
      }
      if (!(error instanceof AttemptInterrupted)) throw error;
    } finally {
      await owner.end();
      this.verifyingJobs.delete(job.id);
    }
  }

  /* ── Terminal transitions ──────────────────────────────────────────── */

  private async failAttempt(job: JobRow, code: string, reason: string, options = { interrupt: true }): Promise<void> {
    if (!await this.isCurrent(job)) return;
    await this.failJob(job.id, code, reason, { ...options, expectedAttempt: job.attemptCount });
  }

  private async terminalTransition(jobId: string, status: 'succeeded' | 'failed' | 'cancelled', summary: string, code: string | null, expectedAttempt?: number): Promise<JobRow | null> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await db.query<DbJobRow>(`UPDATE executor.jobs SET status = $2,
        summary = CASE WHEN $2 = 'succeeded' THEN $3 ELSE summary END,
        error_code = CASE WHEN $2 = 'failed' THEN $4 ELSE error_code END,
        failure_reason = CASE WHEN $2 = 'failed' THEN $3 ELSE failure_reason END,
        finished_at = NOW(), version = version + 1, updated_at = NOW()
        WHERE id = $1 AND status NOT IN ('failed', 'succeeded', 'cancelled')
          AND ($5::int IS NULL OR attempt_count = $5) RETURNING *`,
      [jobId, status, summary, code, expectedAttempt ?? null]);
      const job = result.rows[0] ? rowToJob(result.rows[0]) : null;
      if (job) await db.query(`UPDATE executor.manual_approvals SET state=$2,updated_at=now() WHERE job_id=$1 AND state IN ('pending','decision_recorded')`,[jobId,status === 'cancelled' ? 'cancelled' : 'expired']);
      if (job) await appendJobEvent(db, {
        jobId, eventType: status === 'succeeded' ? EVENT.EXECUTION_SUCCEEDED : status === 'failed' ? EVENT.EXECUTION_FAILED : EVENT.EXECUTION_CANCELLED,
        summary: summary || `Job ${status}.`,
        payload: status === 'failed' ? { code, reason: summary, attempts: job.attemptCount, maxAttempts: job.maxAttempts,
          retryExhausted: RETRYABLE_ERROR_CODES.has(code!) && job.attemptCount >= job.maxAttempts } : { summary },
      });
      await db.query('COMMIT');
      if (job) {
        const deadline = this.deadlines.get(jobId);
        if (deadline) clearTimeout(deadline.timer);
        this.deadlines.delete(jobId);
      }
      return job;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally { db.release(); }
  }

  private async succeedJob(job: JobRow, summary: string): Promise<void> {
    await this.terminalTransition(job.id, 'succeeded', summary, null, job.attemptCount);
  }

  /**
   * Fail a job — or REQUEUE it when the failure class is retryable and the
   * attempt budget is not spent. The requeue is ONE atomic UPDATE straight
   * from the active status to `queued` (never passing through `failed`): a
   * hub poll landing mid-transition folds only the queued state, which
   * reads as "running" hub-side — the in-job retry is invisible to the hub
   * beyond the AUTO_RETRY_SCHEDULED/STARTED timeline events. The dying
   * attempt's workspace is checkpointed first (best effort), so the next
   * attempt's preamble can truthfully point at the branch.
   */
  async failJob(jobId: string, code: string, reason: string, options: { interrupt: boolean; expectedAttempt?: number } = { interrupt: true }): Promise<void> {
    const initial = (await this.pool.query<DbJobRow>('SELECT * FROM executor.jobs WHERE id = $1', [jobId])).rows[0];
    if (!initial || TERMINAL_STATUSES.includes(initial.status as JobStatus) ||
        (options.expectedAttempt !== undefined && initial.attempt_count !== options.expectedAttempt)) return;
    options = { ...options, expectedAttempt: initial.attempt_count };
    this.commands.get(jobId)?.abort();
    if (RETRYABLE_ERROR_CODES.has(code)) {
      const current = (await this.pool.query<DbJobRow>(
        `SELECT * FROM executor.jobs WHERE id = $1`, [jobId])).rows[0];
      if (current && !TERMINAL_STATUSES.includes(current.status as JobStatus)) {
        const job = rowToJob(current);
        if (job.attemptCount !== options.expectedAttempt) return;
        if (job.attemptCount < job.maxAttempts) {
          // Safety net: sweep the failed attempt's leftovers onto the branch,
          // or the next attempt's "continue from the committed work" preamble
          // lies. Conflicts/other failures degrade to an honest preamble.
          let committed = false;
          if (job.worktreePath && existsSync(job.worktreePath)) {
            try {
              await commitJobChanges(this.git, {
                path: job.worktreePath, message: `executor: checkpoint after failed attempt ${job.attemptCount}`,
              });
              committed = true;
            } catch { /* the retry preamble says the worktree may be dirty */ }
          }
          const delayMinutes = resolveRetryDelayMinutes(job.spec, this.config);
          const nextAttempt = job.attemptCount + 1;
          const { rows } = await this.pool.query<DbJobRow>(`
            UPDATE executor.jobs SET
              status = 'queued',
              started_at = NULL,
              attempt_count = $2,
              retry_backoff_until = NOW() + ($3 || ' minutes')::interval,
              opencode_session_id = NULL,
              error_code = $4,
              failure_reason = $5,
              metadata = metadata || $6::jsonb,
              version = version + 1,
              updated_at = NOW()
            WHERE id = $1 AND NOT status = ANY($7::text[]) AND attempt_count < max_attempts AND attempt_count = $8
            RETURNING *`, [
            jobId, nextAttempt, String(delayMinutes), code, reason.slice(0, 4000),
            JSON.stringify({ retryState: { code, reason: reason.slice(0, 500), committed },permissionWaitStartedAt:null,permissionWaitMs:0,permissionResumedAt:0 }),
            TERMINAL_STATUSES,
            job.attemptCount,
          ]);
          if (rows[0]) {
            // The update cleared the session id; release the old turn so
            // the OpenCode service can reap it (best effort).
            if (job.opencodeSessionId) await this.interruptSession(job);
            const when = delayMinutes > 0 ? `in ~${delayMinutes} min` : 'on the next admission tick';
            await appendJobEvent(this.pool, {
              jobId, eventType: EVENT.AUTO_RETRY_SCHEDULED,
              summary: `Attempt ${job.attemptCount} failed (${code}); retry ${nextAttempt} of ${job.maxAttempts} scheduled ${when}.`,
              payload: {
                attempt: nextAttempt, maxAttempts: job.maxAttempts, delayMinutes, code,
                reason: firstLine(reason), committed,
              },
            });
            return;
          }
          // A racing retry/terminal transition won; never fail its successor.
          return;
        }
      }
    }
    const failed = await this.terminalTransition(jobId, 'failed', reason.slice(0, 4000), code, options.expectedAttempt);
    if (!failed) return;
    if (options.interrupt) await this.interruptSession(failed);
  }

  /** Interrupt the job's OpenCode session, best effort. Returns whether the
   *  interrupt was actually sent (false when there is nothing to interrupt). */
  private async interruptSession(job: JobRow): Promise<boolean> {
    if (!this.client || !job.opencodeSessionId) return false;
    try {
      await this.client.interrupt(job.opencodeSessionId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fail closed on pending permission approvals. A persona rule resolving to
   * `ask` blocks its tool forever in an unattended run — the wedge the stall
   * detector used to report as "the call never executed" (it never spawned:
   * it was waiting for an approval no one would ever answer). Rejecting turns
   * it into an immediate `permission.rejected` tool error the model can adapt
   * to, and the timeline records every rejection. Runs every poll tick, well
   * under the stall thresholds. Best effort: a listing failure just means the
   * next tick retries. Returns how many were rejected.
   */
  private async rejectPendingPermissions(job: JobRow): Promise<number> {
    if (!this.client || !job.opencodeSessionId) return 0;
    let pending: OpenCodePermissionRequest[];
    try {
      pending = await this.client.listPermissionRequests(job.opencodeSessionId);
    } catch {
      return 0;
    }
    for (const request of pending) {
      try {
        await this.client!.replyPermission(job.opencodeSessionId!, request.id, 'reject', PERMISSION_REJECT_FEEDBACK);
      } catch {
        // Already answered (a reject clears every pending request in the
        // session, so later ids 404) — nothing left to do for this one.
        continue;
      }
      const what = request.resources?.length
        ? `${request.action ?? 'tool'}: ${request.resources.join(', ').slice(0, 120)}`
        : (request.action ?? 'tool');
      await appendJobEvent(this.pool, {
        jobId: job.id,
        eventType: EVENT.PERMISSION_REJECTED,
        summary: `Auto-rejected an unattended \`${what}\` approval request — no human is here to approve it.`,
        payload: { requestId: request.id, action: request.action ?? null, resources: request.resources ?? [] },
      });
    }
    return pending.length;
  }

  private async mergeMetadata(jobId: string, patch: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE executor.jobs SET metadata = metadata || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [jobId, JSON.stringify(patch)]);
  }

  /* ── Hub-driven actions ────────────────────────────────────────────── */

  /** Send a message into the job's SAME session (resume semantics). */
  async sendMessage(hubJobId: string, text: string): Promise<JobRow> {
    const job = await getJobByHubId(this.pool, hubJobId);
    if (!job) throw new EngineError(404, `Unknown job ${hubJobId}.`);
    // Share polling/launch/verification ownership across processes. Otherwise
    // an in-flight messages fetch can fail or interrupt a continuation that
    // was accepted after that fetch's snapshot. Use a dedicated connection,
    // and re-read eligibility AFTER acquiring the lock; no pool row lock is
    // held during remote I/O and no owned path recursively calls this method.
    const owner = new Client(this.pool.options);
    try {
      await owner.connect();
      await owner.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [job.id]);
      return await this.sendMessageOwned(hubJobId, text);
    } finally { await owner.end(); }
  }

  private async sendMessageOwned(hubJobId: string, text: string): Promise<JobRow> {
    const job = await getJobByHubId(this.pool, hubJobId);
    if (!job) throw new EngineError(404, `Unknown job ${hubJobId}.`);
    if (job.metadata.supersededBy) throw new EngineError(409, 'This stage handed its branch to a newer stage.');
    if (TERMINAL_STATUSES.includes(job.status)) {
      throw new EngineError(409, `Job is ${job.status} — it cannot take new messages.`);
    }
    if (!job.opencodeSessionId || !this.client) {
      throw new EngineError(409, 'This job has no active OpenCode session.');
    }
    if (await reconcileManualApprovals(this.pool,this.client,job.id)) throw new EngineError(409,'Waiting for permission; decide the original request instead of sending a resume prompt.');
    try {
      await this.promptCurrent(job, job.opencodeSessionId, text);
    } catch (error) {
      throw new EngineError(502, error instanceof Error ? error.message : String(error));
    }
    await appendJobEvent(this.pool, {
      jobId: job.id, eventType: EVENT.HUB_MESSAGE, source: 'hub',
      summary: text.slice(0, SUMMARY_LIMIT), payload: { text },
    });
    if (job.status === 'waiting_for_user') {
      await this.pool.query(`
        UPDATE executor.jobs SET status = 'running', verification_attempt_count = 0,
          version = version + 1, updated_at = NOW()
        WHERE id = $1 AND status = 'waiting_for_user'`, [job.id]);
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.EXECUTION_STATUS_CHANGED, summary: 'User replied — resumed.',
      });
    }
    return (await getJobByHubId(this.pool, hubJobId))!;
  }

  /** Cancel idempotently: interrupt best-effort; unless already terminal,
   *  mark cancelled + record the event. Always returns the current job. */
  async cancel(hubJobId: string): Promise<JobRow | null> {
    const job = await getJobByHubId(this.pool, hubJobId);
    if (!job) return null;
    if (TERMINAL_STATUSES.includes(job.status)) return job;
    await this.terminalTransition(job.id, 'cancelled', 'Job cancelled by the hub.', null);
    this.commands.get(job.id)?.abort();
    await this.interruptSession(job);
    return (await getJobByHubId(this.pool, hubJobId))!;
  }

  /** Re-run the verification command (allowed from failed/succeeded, and a
   *  fresh kick from a stale `verifying` row). A manual re-verify is a fresh
   *  chance: the attempt counter resets. */
  async verifyNow(hubJobId: string): Promise<JobRow> {
    const job = await getJobByHubId(this.pool, hubJobId);
    if (!job) throw new EngineError(404, `Unknown job ${hubJobId}.`);
    if (job.metadata.supersededBy) throw new EngineError(409, 'This stage handed its branch to a newer stage.');
    if (['created', 'queued', 'running', 'waiting_for_user'].includes(job.status)) {
      throw new EngineError(409, `Cannot verify a ${job.status} job.`);
    }
    if (!job.verificationCommand) throw new EngineError(409, 'This job has no verification command.');
    if (!job.worktreePath || !existsSync(job.worktreePath)) {
      throw new EngineError(409, 'The job workspace is gone — it cannot be verified again.');
    }
    if (this.verifyingJobs.has(job.id)) {
      throw new EngineError(409, 'A verification is already running for this job.');
    }
    if (job.status === 'verifying') {
      // Recovery adopts the existing generation without resetting its clock
      // or counters; database ownership excludes a live remote worker.
      this.track(this.runVerification(job));
      return job;
    }
    const { rowCount } = await this.pool.query(
      `UPDATE executor.jobs SET status = 'verifying', verification_attempt_count = 0,
         attempt_count = attempt_count + 1, started_at = NOW(), finished_at = NULL,
         version = version + 1, updated_at = NOW()
       WHERE id = $1 AND status IN ('failed', 'succeeded') AND attempt_count = $2`, [job.id, job.attemptCount]);
    if (!rowCount) {
      throw new EngineError(409, `Job moved while verifying — it is no longer ${job.status}.`);
    }
    await appendJobEvent(this.pool, {
      jobId: job.id, eventType: EVENT.EXECUTION_STATUS_CHANGED, summary: 'Manual re-verification requested.',
    });
    const fresh = (await getJobByHubId(this.pool, hubJobId))!;
    this.track(this.runVerification(fresh));
    return fresh;
  }

  /* ── Merge ─────────────────────────────────────────────────────────── */

  async mergeJob(hubJobId: string): Promise<Record<string, unknown>> {
    const job = await getJobByHubId(this.pool, hubJobId);
    if (!job) throw new EngineError(404, `Unknown job ${hubJobId}.`);
    if (job.metadata.supersededBy) throw new EngineError(409, 'This stage handed its branch to a newer stage.');
    if (job.status !== 'succeeded' || !job.branch) {
      throw new EngineError(409, 'Only a succeeded job with a branch can merge.');
    }
    const repoRoot = typeof job.metadata.repoRoot === 'string' ? job.metadata.repoRoot : '';
    const baseSha = typeof job.metadata.baseSha === 'string' ? job.metadata.baseSha : undefined;
    if (!repoRoot || !baseSha) {
      throw new EngineError(409, 'This job has no recorded workspace metadata to merge from.');
    }
    const baseRef = typeof job.metadata.baseRef === 'string' && job.metadata.baseRef
      ? job.metadata.baseRef
      : await resolveBaseRef(this.git, repoRoot, this.config.baseRef);

    // Safety net: sweep the agent's leftovers onto the branch first. An
    // unresolved conflict blocks the whole merge with 409.
    if (job.worktreePath && existsSync(job.worktreePath)) {
      try {
        await commitJobChanges(this.git, { path: job.worktreePath, message: 'executor: safety-net commit before merge' });
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new EngineError(409, error.message, { conflicts: error.files });
        }
        throw new EngineError(500, error instanceof Error ? error.message : String(error));
      }
    }

    const result = await mergeJobBranch(this.git, {
      repoRoot, branch: job.branch, baseSha, baseRef,
      message: `executor: merge ${job.branch} (${job.title || job.hubJobId})`,
    });
    if (!result.ok) {
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.WORKTREE_MERGE_FAILED,
        summary: result.conflicts?.length
          ? `Merge conflicts in ${result.conflicts.length} file(s).`
          : `Merge failed: ${result.error ?? 'unknown error'}`,
        payload: { conflicts: result.conflicts ?? null, error: result.error ?? null, baseRef },
      });
      return { merged: false, conflicts: result.conflicts ?? [], error: result.error ?? '', baseRef };
    }

    const mergeSha = result.merged ? result.mergeSha! : result.branchSha!;
    await this.pool.query(
      `UPDATE executor.jobs SET merged_sha = $2, metadata = metadata || $3::jsonb, updated_at = NOW()
       WHERE id = $1`, [job.id, mergeSha, JSON.stringify({ mergedSha: mergeSha })]);
    await appendJobEvent(this.pool, {
      jobId: job.id, eventType: EVENT.WORKTREE_MERGED,
      summary: `Merged into ${baseRef} (${mergeSha.slice(0, 10)}).`,
      payload: { mergeSha, baseRef, alreadyContained: !result.merged },
    });
    if (!result.merged) {
      await this.removeWorkspace(repoRoot, job);
      return { merged: true, mergeSha, alreadyContained: true, baseRef };
    }

    await this.syncCheckoutBestEffort(repoRoot, baseRef, job.id);

    if (this.config.deployCommand) {
      const deploy = await runDeployCommand(this.config.deployCommand, repoRoot);
      if (deploy.code !== 0) {
        await appendJobEvent(this.pool, {
          jobId: job.id, eventType: EVENT.WORKTREE_DEPLOY_FAILED,
          summary: `Deploy failed (exit ${deploy.code}).`, payload: { command: this.config.deployCommand, output: deploy.output },
        });
        await this.removeWorkspace(repoRoot, job);
        return { merged: true, mergeSha, baseRef, deployError: deploy.output || `exit ${deploy.code}` };
      }
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.WORKTREE_DEPLOYED,
        summary: 'Deploy finished.', payload: { command: this.config.deployCommand, output: deploy.output },
      });
    }

    await this.removeWorkspace(repoRoot, job);
    return { merged: true, mergeSha, baseRef };
  }

  private async syncCheckoutBestEffort(repoRoot: string, baseRef: string, jobId: string): Promise<void> {
    try {
      const sync = await syncCheckout(this.git, { repoRoot, baseRef });
      if (!sync.synced) {
        await appendJobEvent(this.pool, {
          jobId, eventType: EVENT.EXECUTION_STATUS_CHANGED,
          summary: `Checkout left on its own branch (${sync.reason ?? 'not synced'}).`,
        });
      }
    } catch (error) {
      this.onError(error);
    }
  }

  /**
   * The ONLY workspace deletion in the whole engine — reached exclusively
   * from the hub-invoked merge op (ops.ts `jobs/:jobId/merge`), by which
   * point the branch's work has landed in the base ref. Failure/retry
   * flows never call this.
   */
  private async removeWorkspace(repoRoot: string, job: JobRow): Promise<void> {
    if (!job.worktreePath || !job.branch) return;
    await removeJobWorkspace(this.git, { repoRoot, path: job.worktreePath, branch: job.branch, deleteBranch: !job.metadata.supersededBy })
      .catch((error) => this.onError(error));
  }

  /**
   * Terminal jobs (succeeded/failed/cancelled) whose `finished_at` is
   * older than the retention window and that STILL hold a workspace — the
   * retention violations. Read-only: detection never deletes.
   */
  async listStaleWorkspaces(): Promise<StaleWorkspace[]> {
    const days = this.config.workspaceRetentionDays;
    if (!days || days <= 0) return [];
    const { rows } = await this.pool.query<DbJobRow>(`
      SELECT * FROM executor.jobs
      WHERE status = ANY($1::text[])
        AND finished_at IS NOT NULL
        AND finished_at < NOW() - ($2 || ' days')::interval
        AND worktree_path <> ''
      ORDER BY finished_at ASC LIMIT 50`, [TERMINAL_STATUSES, String(days)]);
    return rows.map((row) => {
      const job = rowToJob(row);
      return {
        jobId: job.hubJobId,
        status: job.status,
        title: job.title,
        branch: job.branch,
        worktreePath: job.worktreePath,
        repoRoot: typeof job.metadata.repoRoot === 'string' ? job.metadata.repoRoot : '',
        finishedAt: job.finishedAt!,
        notified: typeof job.metadata.retentionNotifiedAt === 'string',
      };
    });
  }

  /**
   * The retention sweep — VALIDATION ONLY unless explicitly forced:
   *
   * - default (the hourly tick): stale workspaces are REPORTED, never
   *   deleted. Each flagged job gets ONE WORKSPACE_RETENTION_VIOLATION
   *   event (deduped via `metadata.retentionNotifiedAt`), and the stale
   *   set is surfaced in `status.get` — that is the hub's notification
   *   surface.
   * - `force: true` (a user-confirmed maintenance op after the first
   *   validation error): the stale workspaces are actually removed
   *   (worktree + branch), their pointers cleared, WORKSPACE_CLEANED
   *   recorded.
   *
   * The tick throttles itself (hourly); forced calls always run.
   */
  async sweepTerminalWorkspaces(options: { force?: boolean } = {}): Promise<{ stale: StaleWorkspace[]; removed: string[] }> {
    const force = options.force === true;
    if (!force) {
      const now = this.now();
      if (now - this.lastWorkspaceSweepAt < WORKSPACE_SWEEP_INTERVAL_MS) return { stale: [], removed: [] };
      this.lastWorkspaceSweepAt = now;
    }
    const days = this.config.workspaceRetentionDays;
    const stale = (await this.listStaleWorkspaces()).slice(0, 25);
    const removed: string[] = [];
    for (const entry of stale) {
      const { rows } = await this.pool.query<DbJobRow>(
        `SELECT * FROM executor.jobs WHERE hub_job_id = $1`, [entry.jobId]);
      const job = rows[0] ? rowToJob(rows[0]) : null;
      if (!job) continue;
      if (!force) {
        if (!entry.notified) {
          await appendJobEvent(this.pool, {
            jobId: job.id, eventType: EVENT.WORKSPACE_RETENTION_VIOLATION,
            summary: `Workspace is ${days}+ days past ${job.status} — retention policy says delete it; deletion needs an explicit force (POST /api/v1/maintenance/workspace-sweep {"force":true}).`,
            payload: { branch: job.branch, path: job.worktreePath, status: job.status, retentionDays: days },
          });
          await this.mergeMetadata(job.id, { retentionNotifiedAt: new Date(this.now()).toISOString() });
        }
        continue;
      }
      if (entry.repoRoot && job.branch && job.worktreePath) {
        await removeJobWorkspace(this.git, { repoRoot: entry.repoRoot, path: job.worktreePath, branch: job.branch })
          .catch((error) => this.onError(error));
        await appendJobEvent(this.pool, {
          jobId: job.id, eventType: EVENT.WORKSPACE_CLEANED,
          summary: `Workspace removed by forced retention sweep (${days} days after ${job.status}).`,
          payload: { branch: job.branch, path: job.worktreePath, status: job.status, retentionDays: days, forced: true },
        });
        removed.push(entry.jobId);
      }
      // Empty-string sentinels — the schema declares both columns NOT NULL
      // DEFAULT '' (same convention as `model`/`merged_sha`), and every
      // consumer guards with falsy checks.
      await this.pool.query(
        `UPDATE executor.jobs SET worktree_path = '', branch = '', version = version + 1, updated_at = NOW()
         WHERE id = $1`, [job.id]);
    }
    return { stale, removed };
  }
}
