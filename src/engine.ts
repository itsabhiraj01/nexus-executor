import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { ExecutorConfig } from './config.js';
import type { SqlExecutor } from './db.js';
import {
  OpenCodeError,
  agentErrorSummary,
  asksUserForInput,
  collectToolProgress,
  detectStall,
  evaluateToolProgress,
  fallbackPrompt,
  finalAssistantText,
  isModelLimitError,
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
} from './opencode.js';
import {
  ConflictError,
  commitJobChanges,
  execGit,
  materializeJobAttachments,
  mergeJobBranch,
  prepareWorktree,
  removeJobWorkspace,
  resolveBaseRef,
  runDeployCommand,
  runJobCommand,
  jobEnv,
  syncCheckout,
  type AttachmentFile,
  type GitRunner,
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
  jobId: string;
  title?: string;
  prompt: string;
  verificationCommand?: string;
  project?: ProjectSpec | null;
  models?: string[];
  attachments?: JobAttachmentInput[];
  retry?: JobRetrySpec | null;
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
  WORKTREE_MERGED: 'WORKTREE_MERGED',
  WORKTREE_MERGE_FAILED: 'WORKTREE_MERGE_FAILED',
  WORKTREE_DEPLOYED: 'WORKTREE_DEPLOYED',
  WORKTREE_DEPLOY_FAILED: 'WORKTREE_DEPLOY_FAILED',
  AUTO_RETRY_SCHEDULED: 'AUTO_RETRY_SCHEDULED',
  AUTO_RETRY_STARTED: 'AUTO_RETRY_STARTED',
  MODEL_FALLBACK: 'MODEL_FALLBACK',
} as const;

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
    const bumped = await db.query<{ event_seq: string | number }>(`
      UPDATE executor.jobs SET
        event_seq = GREATEST(
          event_seq,
          (SELECT COALESCE(MAX(sequence_number), 0) FROM executor.job_events WHERE job_id = $1)) + 1,
        updated_at = NOW()
      WHERE id = $1
      RETURNING event_seq`, [input.jobId]);
    const sequence = Number(bumped.rows[0]?.event_seq ?? 0);
    if (!sequence) throw new Error(`Job ${input.jobId} disappeared while appending an event`);
    try {
      await db.query(`
        INSERT INTO executor.job_events (job_id, sequence_number, event_type, source, summary, payload, message_id)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`, [
        input.jobId,
        sequence,
        input.eventType,
        input.source ?? 'executor',
        input.summary.slice(0, SUMMARY_LIMIT),
        JSON.stringify(capPayload(input.payload)),
        input.messageId ?? null,
      ]);
      return sequence;
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

/** The stall failure reason (mirrors the hub's wording, minus the
 *  OpenCode-version specifics). */
export function stallFailureReason(summary: string, interrupted?: boolean): string {
  return [
    `Agent stalled — ${summary}. This matches the known OpenCode wedge (a tool call marked running never executes; a nudge cannot help — the stuck turn never reads messages, only an interrupt unsticks it).`,
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
const SEEN_IDS_CAP = 500;

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
  /** Detached verification cycles — tests drain them via `drain()`. */
  private readonly pending = new Set<Promise<unknown>>();

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
    await Promise.all([...this.pending]);
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
    const inserted = await this.pool.query<DbJobRow>(`
      INSERT INTO executor.jobs (hub_job_id, title, spec, prompt, verification_command, max_attempts)
      VALUES ($1, $2, $3::jsonb, $4, $5, $6)
      ON CONFLICT (hub_job_id) DO NOTHING
      RETURNING *`, [
      spec.jobId,
      spec.title ?? '',
      JSON.stringify(spec),
      spec.prompt,
      spec.verificationCommand ?? '',
      resolveMaxAttempts(spec, this.config),
    ]);
    if (!inserted.rows[0]) {
      const existing = await getJobByHubId(this.pool, spec.jobId);
      if (!existing) throw new Error(`Job ${spec.jobId} was simultaneously deleted`);
      return { job: existing, created: false };
    }
    const job = rowToJob(inserted.rows[0]);
    await this.admitOne(job);
    return { job: (await getJobByHubId(this.pool, spec.jobId))!, created: true };
  }

  /**
   * Admit one freshly created job: launch it when the OpenCode service is
   * configured and a slot is free (counting OTHER occupants — this job is
   * already in the created state), otherwise park it queued.
   */
  private async admitOne(job: JobRow): Promise<void> {
    if (!this.client) {
      await this.queueJob(job, 'OpenCode is not configured — the job waits queued.');
      return;
    }
    const { rows } = await this.pool.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM executor.jobs
      WHERE status IN ('created', 'running', 'verifying') AND id <> $1`, [job.id]);
    if ((rows[0]?.n ?? 0) >= this.config.maxParallelJobs) {
      await this.queueJob(job, 'Queued behind running jobs.');
      return;
    }
    await this.launchJob(job);
  }

  private async queueJob(job: JobRow, summary: string): Promise<void> {
    const { rowCount } = await this.pool.query(
      `UPDATE executor.jobs SET status = 'queued', version = version + 1, updated_at = NOW()
       WHERE id = $1 AND status = 'created'`, [job.id]);
    if (rowCount) {
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.EXECUTION_STATUS_CHANGED, summary,
      });
    }
  }

  /**
   * Worker admission step: heal leftover `created` rows (a crash between
   * insert and launch) and promote queued jobs while slots are free.
   */
  async admitQueued(): Promise<void> {
    const { rows: countRows } = await this.pool.query<{ n: number }>(`
      SELECT count(*)::int AS n FROM executor.jobs WHERE status IN ('created', 'running', 'verifying')`);
    let free = this.config.maxParallelJobs - (countRows[0]?.n ?? 0);
    const { rows } = await this.pool.query<DbJobRow>(`
      SELECT * FROM executor.jobs WHERE status IN ('created', 'queued')
        AND (retry_backoff_until IS NULL OR retry_backoff_until <= NOW())
        ORDER BY created_at ASC LIMIT 25`);
    for (const raw of rows) {
      const job = rowToJob(raw);
      if (job.status === 'created') {
        if (job.opencodeSessionId) {
          // Crashed after the session was made but before running: resume.
          await this.pool.query(
            `UPDATE executor.jobs SET status = 'running', started_at = COALESCE(started_at, NOW()), version = version + 1, updated_at = NOW()
             WHERE id = $1 AND status = 'created'`, [job.id]);
        } else if (this.client) {
          // Crashed pre-launch; the created row already occupies its slot.
          await this.launchJob(job).catch((error) => this.onError(error));
        } else {
          await this.queueJob(job, 'OpenCode is not configured — the job waits queued.');
        }
        continue;
      }
      if (!this.client || free <= 0) continue;
      free -= 1;
      await this.launchJob(job).catch((error) => this.onError(error));
    }
  }

  /* ── Launch ────────────────────────────────────────────────────────── */

  private async resolveRepoRoot(spec: JobSpecInput): Promise<string> {
    const project = spec.project;
    if (project?.localPath) return project.localPath;
    if (project?.repoUrl) return this.cloneRepo(project.repoUrl);
    throw new Error('The job project must carry a localPath or a repoUrl — there is nowhere to work.');
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

  /**
   * Launch one job: resolve the repo, cut the worktree on a snapshot base
   * (or REUSE the previous attempt's branch on a retry), materialize
   * attachments (git-excluded), create the OpenCode session in the
   * worktree and send the composed prompt. Any failure lands the job in
   * `failed` (or re-queued when the retry budget allows) with the first
   * attempt's freshly-cut workspace cleaned up.
   */
  async launchJob(job: JobRow): Promise<void> {
    const fromStatus = job.status;
    const isRetry = job.attemptCount > 1;
    const retryState = (job.metadata.retryState ?? null) as { code?: string; reason?: string; committed?: boolean } | null;
    let prepared: { branch: string; path: string; baseSha: string } | null = null;
    let repoRoot: string | null = null;
    try {
      const spec = job.spec;
      repoRoot = await this.resolveRepoRoot(spec);
      const baseRef = await resolveBaseRef(this.git, repoRoot, this.config.baseRef);
      if (isRetry && job.branch) {
        prepared = await this.resumeWorkspace(repoRoot, job);
        if (prepared.path !== job.worktreePath) {
          await this.pool.query(
            `UPDATE executor.jobs SET worktree_path = $2, version = version + 1, updated_at = NOW()
             WHERE id = $1 AND status = $3`, [job.id, prepared.path, fromStatus]);
        }
      } else {
        prepared = await prepareWorktree(
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

      // The model: the spec's priority list AT the position any usage-limit
      // fallback walked to (the position is job-wide, surviving attempts).
      const priority = (spec.models ?? [])
        .map((entry) => parseModelRef(entry))
        .filter((entry): entry is ModelRef => entry !== null);
      const modelIndex = Math.min(
        Math.max(0, typeof job.metadata.modelIndex === 'number' ? job.metadata.modelIndex : 0),
        Math.max(0, priority.length - 1),
      );
      const modelRef = priority[modelIndex] ?? null;
      const composed = await this.composePrompt(spec, attachmentsDir, attachmentFiles);
      const prompt = isRetry
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
      const session = await this.client!.createSession({
        title: job.title || `Job ${job.hubJobId}`,
        directory: prepared.path,
        model: modelRef,
      });
      const modelEcho = session.model?.id
        ? `${session.model.providerID ?? ''}/${session.model.id}`
        : (modelRef ? `${modelRef.providerID}/${modelRef.modelID}` : '');
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

      const sent = await this.client!.prompt(session.id, prompt);
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
      const code = (error as { code?: string }).code === 'workspace_setup_failed'
        ? 'workspace_setup_failed' : 'session_setup_failed';
      await this.failJob(job.id, code, error instanceof Error ? error.message : String(error), { interrupt: false });
      // The first attempt's freshly-cut workspace is disposable. A retry's
      // branch and worktree are NOT — they carry every earlier attempt's
      // committed work, and the next attempt reuses them.
      if (prepared && repoRoot && !isRetry) {
        await removeJobWorkspace(this.git, { repoRoot, path: prepared.path, branch: prepared.branch })
          .catch(() => { /* best effort */ });
      }
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
    await this.admitQueued().catch((error) => this.onError(error));
    const { rows } = await this.pool.query<DbJobRow>(`
      SELECT * FROM executor.jobs
      WHERE status IN ('running', 'waiting_for_user') AND opencode_session_id IS NOT NULL
      ORDER BY updated_at ASC LIMIT 50`);
    for (const raw of rows) {
      const job = rowToJob(raw);
      await this.pollJob(job).catch((error) => this.onError(error));
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
        await this.failJob(job.id, 'verification_failed',
          'The job workspace is gone — the verification cycle cannot resume.').catch((error) => this.onError(error));
        continue;
      }
      this.track(this.runVerification(job));
    }
    // `verifying` jobs run detached; the timeout still bounds them.
    if (this.config.jobTimeoutMs > 0) {
      const { rows: stuck } = await this.pool.query<DbJobRow>(`
        SELECT * FROM executor.jobs
        WHERE status = 'verifying' AND started_at IS NOT NULL
          AND started_at < NOW() - ($1 || ' milliseconds')::interval`,
        [String(this.config.jobTimeoutMs)]);
      for (const raw of stuck) {
        const job = rowToJob(raw);
        await this.interruptSession(job);
        await this.failJob(job.id, 'execution_timeout',
          `Job timed out after ${Math.round(this.config.jobTimeoutMs / 60_000)} minutes.`);
      }
    }
  }

  async pollJob(job: JobRow): Promise<void> {
    if (!this.client || !job.opencodeSessionId) return;
    let messages: OpenCodeMessage[];
    try {
      messages = await this.client.getMessages(job.opencodeSessionId);
    } catch (error) {
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

    const last = lastAssistant(messages);
    const complete = last ? messageComplete(last) : false;
    const meta = job.metadata;
    const now = this.now();

    // Safety net: every completed turn checkpoints the worktree onto the
    // job's branch before anything else reads the outcome.
    if (complete && job.worktreePath) {
      try {
        await commitJobChanges(this.git, { path: job.worktreePath, message: 'executor: checkpoint after agent turn' });
      } catch (error) {
        this.onError(error);
      }
    }

    if (complete && last && job.status === 'running') {
      if (turnErrored(last)) {
        // An errored turn already handled by a model fallback: the
        // continuation prompt is in flight but the errored message is still
        // the newest assistant row — re-polled, it must NOT fail the job.
        // (The hub gets this from its intermediate agent_finished state.)
        if (job.metadata.lastFallbackMessageId === last.id) return;
        // Usage-limit errors walk the model priority list IN the session —
        // the conversation carries the whole task, the next model continues.
        // Only the final model's limit (or a non-limit error) fails the job.
        const fell = await this.maybeModelFallback(job, last).catch((error) => {
          this.onError(error);
          return false;
        });
        if (fell) return;
        await this.interruptSession(job);
        await this.failJob(job.id, 'agent_error', agentErrorSummary(last.error ?? { message: last.finish ?? 'unknown error' }), { interrupt: false });
        return;
      }
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
      if (last.id !== meta.lastPromotedMessageId) {
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
      const stalled = detectStall(messages, {
        now, toolStallMs: this.config.toolStallMs, silenceStallMs: this.config.silenceStallMs,
      });
      const progress = stalled
        ? { store: readToolFingerprints(meta), stalled: null }
        : evaluateToolProgress(collectToolProgress(messages), readToolFingerprints(meta), {
          now, toolProgressMs: this.config.toolProgressMs,
        });
      await this.mergeMetadata(job.id, { toolFingerprints: progress.store });
      const found = stalled ?? progress.stalled;
      if (found) {
        const interrupted = await this.interruptSession(job);
        await this.failJob(job.id, 'agent_stalled', stallFailureReason(found.summary, interrupted), { interrupt: false });
        return;
      }
      if (this.config.jobTimeoutMs > 0 && job.startedAt && now - job.startedAt.getTime() >= this.config.jobTimeoutMs) {
        await this.interruptSession(job);
        await this.failJob(job.id, 'execution_timeout',
          `Job timed out after ${Math.round(this.config.jobTimeoutMs / 60_000)} minutes.`, { interrupt: false });
      }
    }
  }

  /**
   * Automatic model fallback: when a completed turn ended in a usage-limit
   * error and the job's model priority list still has a next entry, switch
   * the session to it and re-enter the SAME conversation instead of
   * failing. Returns false when the error is not a limit, no model is left,
   * or this errored turn was already handled (one fallback per turn — the
   * worker's next poll then fails the job, where the in-job retry budget
   * applies). Mirrors the hub's fallbackForModelLimit.
   */
  private async maybeModelFallback(job: JobRow, message: OpenCodeMessage): Promise<boolean> {
    if (!this.client || !job.opencodeSessionId) return false;
    const error: OpenCodeMessageError = message.error ?? { message: message.finish ?? '' };
    if (!isModelLimitError(error)) return false;
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
    const prompt = fallbackPrompt(previousName, nextName);

    await this.client.switchModel(job.opencodeSessionId, next);
    const sent = await this.client.prompt(job.opencodeSessionId, prompt);
    await this.mergeMetadata(job.id, {
      modelIndex: modelIndex + 1,
      lastFallbackMessageId: message.id,
    });
    await this.pool.query(
      `UPDATE executor.jobs SET model = $2, updated_at = NOW() WHERE id = $1`, [job.id, nextName]);
    await appendJobEvent(this.pool, {
      jobId: job.id, eventType: EVENT.MODEL_FALLBACK,
      summary: `Model fallback after a usage-limit error: ${previousName ?? 'the previous model'} → ${nextName}.`,
      payload: { from: previousName, to: nextName, reason: agentErrorSummary(error) },
    });
    await appendJobEvent(this.pool, {
      jobId: job.id, eventType: EVENT.PROMPT_SENT,
      summary: 'Continuation prompt sent after the model fallback.',
      payload: { text: prompt, promptMessageId: sent.id },
    });
    return true;
  }

  /* ── Verification ──────────────────────────────────────────────────── */

  /**
   * One detached verification cycle (the job is already `verifying`). Pass
   * → succeeded with the agent's closing summary; fail → a repair prompt
   * into the SAME session while attempts remain, else
   * `failed`/`verification_failed`. Every status write is guarded on
   * `status='verifying'` so a concurrent cancel wins.
   */
  private async runVerification(job: JobRow): Promise<void> {
    if (this.verifyingJobs.has(job.id)) return;
    this.verifyingJobs.add(job.id);
    try {
      const attempts = job.verificationAttemptCount + 1;
      const result = await runJobCommand(job.verificationCommand, job.worktreePath, jobEnv());
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
           WHERE id = $1 AND status = 'verifying'`, [job.id, attempts, meta]);
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
         WHERE id = $1 AND status = 'verifying'`, [job.id, attempts, meta]);
      if (!rowCount) return;
      if (attempts < MAX_VERIFICATION_ATTEMPTS) {
        const repair = repairPrompt(job.verificationCommand, result);
        try {
          await this.client!.prompt(job.opencodeSessionId!, repair);
        } catch (error) {
          await this.failJob(job.id, 'agent_error',
            `The repair prompt could not be sent: ${error instanceof Error ? error.message : String(error)}`, { interrupt: false });
          return;
        }
        await appendJobEvent(this.pool, {
          jobId: job.id, eventType: EVENT.REPAIR_REQUESTED,
          summary: `Repair attempt ${attempts + 1}`, payload: { attempt: attempts, text: repair },
        });
        await this.pool.query(
          `UPDATE executor.jobs SET status = 'running', version = version + 1, updated_at = NOW()
           WHERE id = $1 AND status = 'verifying'`, [job.id]);
      } else {
        await this.failJob(job.id, 'verification_failed',
          `Verification failed ${attempts} times. Last exit code ${result.code}. Output tail: ${result.output.slice(-2000)}`,
          { interrupt: false });
      }
    } finally {
      this.verifyingJobs.delete(job.id);
    }
  }

  /* ── Terminal transitions ──────────────────────────────────────────── */

  private async succeedJob(job: JobRow, summary: string): Promise<void> {
    const { rowCount } = await this.pool.query(`
      UPDATE executor.jobs SET status = 'succeeded', summary = $2, finished_at = NOW(),
        version = version + 1, updated_at = NOW()
      WHERE id = $1 AND status IN ('running', 'verifying')`, [job.id, summary]);
    if (!rowCount) return;
    await appendJobEvent(this.pool, {
      jobId: job.id, eventType: EVENT.EXECUTION_SUCCEEDED,
      summary: summary.slice(0, SUMMARY_LIMIT) || 'Job succeeded.', payload: { summary },
    });
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
  async failJob(jobId: string, code: string, reason: string, options: { interrupt: boolean } = { interrupt: true }): Promise<void> {
    if (RETRYABLE_ERROR_CODES.has(code)) {
      const current = (await this.pool.query<DbJobRow>(
        `SELECT * FROM executor.jobs WHERE id = $1`, [jobId])).rows[0];
      if (current && !TERMINAL_STATUSES.includes(current.status as JobStatus)) {
        const job = rowToJob(current);
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
              attempt_count = $2,
              retry_backoff_until = NOW() + ($3 || ' minutes')::interval,
              opencode_session_id = NULL,
              error_code = $4,
              failure_reason = $5,
              metadata = metadata || $6::jsonb,
              version = version + 1,
              updated_at = NOW()
            WHERE id = $1 AND NOT status = ANY($7::text[]) AND attempt_count < max_attempts
            RETURNING *`, [
            jobId, nextAttempt, String(delayMinutes), code, reason.slice(0, 4000),
            JSON.stringify({ retryState: { code, reason: reason.slice(0, 500), committed } }),
            TERMINAL_STATUSES,
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
          // The UPDATE lost a race with a terminal transition — fall
          // through to the terminal write, which no-ops the same way.
        }
      }
    }
    const { rows } = await this.pool.query<DbJobRow>(`
      UPDATE executor.jobs SET status = 'failed', error_code = $2, failure_reason = $3, finished_at = NOW(),
        version = version + 1, updated_at = NOW()
      WHERE id = $1 AND NOT status = ANY($4::text[])
      RETURNING *`, [jobId, code, reason.slice(0, 4000), TERMINAL_STATUSES]);
    if (!rows[0]) return;
    const failed = rowToJob(rows[0]);
    if (options.interrupt) await this.interruptSession(failed);
    // `retryExhausted` tells the hub (and any reader) that the in-job
    // budget ran out on a retryable class — the failure is final, not a
    // first stumble.
    const retryExhausted = RETRYABLE_ERROR_CODES.has(code) && failed.attemptCount >= failed.maxAttempts;
    await appendJobEvent(this.pool, {
      jobId, eventType: EVENT.EXECUTION_FAILED,
      summary: reason.slice(0, SUMMARY_LIMIT) || 'Job failed.',
      payload: {
        code, reason: reason.slice(0, 4000),
        attempts: failed.attemptCount, maxAttempts: failed.maxAttempts, retryExhausted,
      },
    });
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
    if (TERMINAL_STATUSES.includes(job.status)) {
      throw new EngineError(409, `Job is ${job.status} — it cannot take new messages.`);
    }
    if (!job.opencodeSessionId || !this.client) {
      throw new EngineError(409, 'This job has no active OpenCode session.');
    }
    try {
      await this.client.prompt(job.opencodeSessionId, text);
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
    await this.interruptSession(job);
    const { rowCount } = await this.pool.query(`
      UPDATE executor.jobs SET status = 'cancelled', finished_at = NOW(), version = version + 1, updated_at = NOW()
      WHERE id = $1 AND NOT status = ANY($2::text[])`, [job.id, TERMINAL_STATUSES]);
    if (rowCount) {
      await appendJobEvent(this.pool, {
        jobId: job.id, eventType: EVENT.EXECUTION_CANCELLED, summary: 'Job cancelled by the hub.',
      });
    }
    return (await getJobByHubId(this.pool, hubJobId))!;
  }

  /** Re-run the verification command (allowed from failed/succeeded, and a
   *  fresh kick from a stale `verifying` row). A manual re-verify is a fresh
   *  chance: the attempt counter resets. */
  async verifyNow(hubJobId: string): Promise<JobRow> {
    const job = await getJobByHubId(this.pool, hubJobId);
    if (!job) throw new EngineError(404, `Unknown job ${hubJobId}.`);
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
    const { rowCount } = await this.pool.query(
      `UPDATE executor.jobs SET status = 'verifying', verification_attempt_count = 0,
         version = version + 1, updated_at = NOW()
       WHERE id = $1 AND status IN ('failed', 'succeeded', 'verifying')`, [job.id]);
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

  private async removeWorkspace(repoRoot: string, job: JobRow): Promise<void> {
    if (!job.worktreePath || !job.branch) return;
    await removeJobWorkspace(this.git, { repoRoot, path: job.worktreePath, branch: job.branch })
      .catch((error) => this.onError(error));
  }
}
