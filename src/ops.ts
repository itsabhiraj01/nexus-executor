import type { Pool } from 'pg';
import { readAuthConfig } from './auth.js';
import { EXECUTOR_VERSION, executorCapabilities, type ExecutorConfig } from './config.js';
import {
  EngineError,
  rowToJob,
  type JobEngine,
  type JobRow,
  type JobSpecInput,
} from './engine.js';
import { parseModelRef, type OpenCodeClient } from './opencode.js';
import { readJobLog } from './workspace.js';

/**
 * The executor's operation core, transport-agnostic: ONE implementation
 * behind both the HTTP routes (`/api/v1/*`, direct transport) and the
 * gateway WebSocket dispatcher (gateway transport). Every function returns
 * `{status, body}`; transports encode it identically to the documented
 * contract (docs/remote-executors.md) — HTTP status codes for the listener,
 * `{ok, error, status}` envelopes for the gateway protocol.
 *
 * Error shapes are CONTRACT: `{error: string, ...extra}` everywhere.
 */

export interface RouteDeps {
  pool: Pool;
  config: ExecutorConfig;
  engine: JobEngine;
  client: OpenCodeClient | null;
  startedAt: number;
}

export interface OpResult {
  status: number;
  body: Record<string, unknown>;
}

export function jobSummary(job: JobRow): Record<string, unknown> {
  return {
    id: job.id,
    hubJobId: job.hubJobId,
    status: job.status,
    title: job.title,
    failureReason: job.failureReason,
    errorCode: job.errorCode,
    mergedSha: job.mergedSha || null,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    retryBackoffUntil: job.retryBackoffUntil?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
  };
}

const MAX_PROMPT_CHARS = 200_000;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_CHARS = 50_000;

function asTrimmedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

/* ── POST /api/v1/jobs (job.dispatch) validation ───────────────────────── */

export function validateJobBody(body: unknown): { spec?: JobSpecInput; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Body must be a JSON object.' };
  }
  const input = body as Record<string, unknown>;
  const jobId = asTrimmedString(input.jobId, 200);
  if (!jobId) return { error: 'jobId is required (non-empty string, ≤ 200 chars).' };
  if (input.title !== undefined && typeof input.title !== 'string') return { error: 'title must be a string.' };
  if (typeof input.title === 'string' && input.title.length > 500) return { error: 'title must be ≤ 500 chars.' };
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) return { error: 'prompt is required.' };
  if (input.prompt.length > MAX_PROMPT_CHARS) return { error: `prompt must be ≤ ${MAX_PROMPT_CHARS} chars (got ${input.prompt.length}).` };
  if (input.verificationCommand !== undefined && typeof input.verificationCommand !== 'string') {
    return { error: 'verificationCommand must be a string.' };
  }
  if (typeof input.verificationCommand === 'string' && input.verificationCommand.length > 4_000) {
    return { error: 'verificationCommand must be ≤ 4000 chars.' };
  }

  let project: JobSpecInput['project'] = null;
  if (input.project !== undefined && input.project !== null) {
    if (typeof input.project !== 'object' || Array.isArray(input.project)) {
      return { error: 'project must be an object or null.' };
    }
    const raw = input.project as Record<string, unknown>;
    const repoUrl = asTrimmedString(raw.repoUrl, 2_000) ?? undefined;
    const localPath = asTrimmedString(raw.localPath, 2_000) ?? undefined;
    if (!repoUrl && !localPath) return { error: 'project.localPath or project.repoUrl is required.' };
    for (const key of ['name', 'buildCommand', 'runCommand', 'testCommand', 'customPrompt'] as const) {
      if (raw[key] !== undefined && typeof raw[key] !== 'string') return { error: `project.${key} must be a string.` };
    }
    if (typeof raw.customPrompt === 'string' && raw.customPrompt.length > 20_000) {
      return { error: 'project.customPrompt must be ≤ 20000 chars.' };
    }
    if (typeof raw.name === 'string' && raw.name.length > 200) {
      return { error: 'project.name must be ≤ 200 chars.' };
    }
    project = {
      name: typeof raw.name === 'string' ? raw.name : '',
      repoUrl, localPath,
      buildCommand: typeof raw.buildCommand === 'string' ? raw.buildCommand : undefined,
      runCommand: typeof raw.runCommand === 'string' ? raw.runCommand : undefined,
      testCommand: typeof raw.testCommand === 'string' ? raw.testCommand : undefined,
      customPrompt: typeof raw.customPrompt === 'string' ? raw.customPrompt : undefined,
    };
  }

  let models: string[] = [];
  if (input.models !== undefined && input.models !== null) {
    if (!Array.isArray(input.models) || input.models.length > 5) return { error: 'models must be an array of ≤ 5 entries.' };
    for (const entry of input.models) {
      if (typeof entry !== 'string' || !parseModelRef(entry)) {
        return { error: `models entries must be 'provider/model' strings (got ${JSON.stringify(entry)}).` };
      }
      models.push(entry.trim());
    }
  }

  // The in-job retry budget the hub resolved (project → settings → env
  // chain hub-side): absent fields inherit the executor's own env defaults.
  let retry: JobSpecInput['retry'] = null;
  if (input.retry !== undefined && input.retry !== null) {
    if (typeof input.retry !== 'object' || Array.isArray(input.retry)) {
      return { error: 'retry must be an object or null.' };
    }
    const raw = input.retry as Record<string, unknown>;
    retry = {};
    if (raw.maxAttempts !== undefined && raw.maxAttempts !== null) {
      const parsed = typeof raw.maxAttempts === 'number' ? raw.maxAttempts : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
        return { error: 'retry.maxAttempts must be an integer between 1 and 10.' };
      }
      retry.maxAttempts = parsed;
    }
    if (raw.delayMinutes !== undefined && raw.delayMinutes !== null) {
      const parsed = typeof raw.delayMinutes === 'number' ? raw.delayMinutes : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 60) {
        return { error: 'retry.delayMinutes must be an integer between 0 and 60.' };
      }
      retry.delayMinutes = parsed;
    }
  }

  let attachments: JobSpecInput['attachments'] = [];
  if (input.attachments !== undefined && input.attachments !== null) {
    if (!Array.isArray(input.attachments) || input.attachments.length > MAX_ATTACHMENTS) {
      return { error: `attachments must be an array of ≤ ${MAX_ATTACHMENTS} entries.` };
    }
    let totalBytes = 0;
    for (const entry of input.attachments) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: 'attachments entries must be objects.' };
      const attachment = entry as Record<string, unknown>;
      const name = asTrimmedString(attachment.name, 300);
      if (!name) return { error: 'attachments[].name is required (≤ 300 chars).' };
      if (typeof attachment.mimeType !== 'string' || attachment.mimeType.length > 200) {
        return { error: 'attachments[].mimeType must be a string ≤ 200 chars.' };
      }
      if (typeof attachment.dataBase64 !== 'string' || !/^[A-Za-z0-9+/=\r\n]*$/.test(attachment.dataBase64)) {
        return { error: `attachment "${name}": dataBase64 is not valid base64.` };
      }
      const bytes = Buffer.from(attachment.dataBase64, 'base64');
      totalBytes += bytes.length;
      if (totalBytes > MAX_ATTACHMENT_BYTES) {
        return { error: `Total attachment bytes exceed ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.` };
      }
      attachments.push({ name, mimeType: attachment.mimeType, dataBase64: attachment.dataBase64 });
    }
  }

  return {
    spec: {
      jobId,
      title: typeof input.title === 'string' ? input.title.trim() : '',
      prompt: input.prompt,
      verificationCommand: typeof input.verificationCommand === 'string' ? input.verificationCommand : '',
      project,
      models,
      attachments,
      retry,
    },
  };
}

/** EngineError → contract body; everything else rethrows (a bug/dependency
 *  failure is a 500/503, shaped by the transport). */
export function engineErrorResult(error: unknown): OpResult | null {
  if (error instanceof EngineError) {
    return { status: error.statusCode, body: { error: error.message, ...(error.extra ?? {}) } };
  }
  return null;
}

/* — Operations — */

export async function opStatus(deps: RouteDeps): Promise<OpResult> {
  const { rows } = await deps.pool.query<{ active: number; queued: number; total: number }>(`
    SELECT
      count(*) FILTER (WHERE status IN ('created', 'running', 'verifying', 'waiting_for_user'))::int AS active,
      count(*) FILTER (WHERE status = 'queued')::int AS queued,
      count(*)::int AS total
    FROM executor.jobs`);
  const counts = rows[0] ?? { active: 0, queued: 0, total: 0 };
  return {
    status: 200,
    body: {
      ok: true,
      name: deps.config.executorName,
      version: EXECUTOR_VERSION,
      paired: true,
      opencode: { configured: deps.client !== null, baseUrl: deps.config.opencode.baseUrl },
      jobs: counts,
      // The behavior contract the hub gates on: an executor advertising
      // jobRetries manages in-job retries itself (the hub must not also
      // arm its cross-run auto-retry for those failures — the budgets
      // would multiply).
      capabilities: executorCapabilities(),
      uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
    },
  };
}

export async function opModels(deps: RouteDeps, directory: string | undefined): Promise<OpResult> {
  if (!deps.client) return { status: 503, body: { error: 'OpenCode is not configured' } };
  try {
    const items = await deps.client.listModels(directory ?? deps.config.workspaceRoot);
    return { status: 200, body: { items } };
  } catch (error) {
    return { status: 502, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}

/** Returns the creation status the HTTP route needs (201 vs 200); the
 *  gateway dispatcher flattens to the body alone. */
export async function opCreateJob(deps: RouteDeps, body: unknown): Promise<OpResult & { created?: boolean }> {
  const { spec, error } = validateJobBody(body);
  if (!spec) return { status: 400, body: { error: error! } };
  const { job, created } = await deps.engine.createJob(spec);
  return { status: created ? 201 : 200, created, body: { job: jobSummary(job) } };
}

export async function opJobEvents(deps: RouteDeps, jobId: string, sinceSeq: number, limit: number): Promise<OpResult> {
  const job = await deps.pool.query<{ id: string }>(`SELECT id FROM executor.jobs WHERE hub_job_id = $1`, [jobId]);
  const jobRow = job.rows[0];
  if (!jobRow) return { status: 404, body: { error: `Unknown job ${jobId}.` } };
  const { rows: events } = await deps.pool.query<{
    sequence_number: string | number; event_type: string; source: string; summary: string;
    payload: unknown; created_at: Date;
  }>(`
    SELECT sequence_number, event_type, source, summary, payload, created_at
    FROM executor.job_events
    WHERE job_id = $1 AND sequence_number > $2
    ORDER BY sequence_number ASC
    LIMIT $3`, [jobRow.id, sinceSeq, limit]);
  return {
    status: 200,
    body: {
      events: events.map((event) => ({
        seq: Number(event.sequence_number),
        type: event.event_type,
        source: event.source,
        summary: event.summary,
        payload: event.payload ?? {},
        createdAt: event.created_at.toISOString(),
      })),
    },
  };
}

/** GET /api/v1/jobs/:jobId — the summary plus workspace/agent detail. */
export async function opShowJob(deps: RouteDeps, hubJobId: string): Promise<OpResult> {
  const { rows } = await deps.pool.query<Parameters<typeof rowToJob>[0]>(
    `SELECT * FROM executor.jobs WHERE hub_job_id = $1`, [hubJobId]);
  const row = rows[0];
  if (!row) return { status: 404, body: { error: `Unknown job ${hubJobId}.` } };
  const job = rowToJob(row);
  const { rows: countRows } = await deps.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM executor.job_events WHERE job_id = $1`, [job.id]);
  const verification = (job.metadata.verification ?? {}) as { attempts?: number; exitCode?: number; outputTail?: string };
  return {
    status: 200,
    body: {
      ...jobSummary(job),
      branch: job.branch,
      worktreePath: job.worktreePath,
      opencodeSessionId: job.opencodeSessionId,
      model: job.model,
      summary: job.summary,
      verification: {
        attempts: job.verificationAttemptCount > 0 ? job.verificationAttemptCount : (verification.attempts ?? 0),
        lastExitCode: typeof verification.exitCode === 'number' ? verification.exitCode : null,
        lastOutputTail: typeof verification.outputTail === 'string' ? verification.outputTail : '',
      },
      eventCount: countRows[0]?.n ?? 0,
    },
  };
}

export async function opJobMessage(deps: RouteDeps, jobId: string, text: string): Promise<OpResult> {
  try {
    await deps.engine.sendMessage(jobId, text);
    return { status: 200, body: { ok: true } };
  } catch (error) {
    const result = engineErrorResult(error);
    if (result) return result;
    throw error;
  }
}

export async function opJobCancel(deps: RouteDeps, jobId: string): Promise<OpResult> {
  const job = await deps.engine.cancel(jobId);
  if (!job) return { status: 404, body: { error: `Unknown job ${jobId}.` } };
  return { status: 200, body: { job: jobSummary(job) } };
}

export async function opJobVerify(deps: RouteDeps, jobId: string): Promise<OpResult> {
  try {
    const job = await deps.engine.verifyNow(jobId);
    return { status: 200, body: { job: jobSummary(job) } };
  } catch (error) {
    const result = engineErrorResult(error);
    if (result) return result;
    throw error;
  }
}

export async function opJobMerge(deps: RouteDeps, jobId: string): Promise<OpResult> {
  try {
    return { status: 200, body: await deps.engine.mergeJob(jobId) as Record<string, unknown> };
  } catch (error) {
    const result = engineErrorResult(error);
    if (result) return result;
    throw error;
  }
}

export async function opJobLog(deps: RouteDeps, jobId: string): Promise<OpResult> {
  const job = await deps.pool.query<Parameters<typeof rowToJob>[0]>(
    `SELECT * FROM executor.jobs WHERE hub_job_id = $1`, [jobId]);
  const row = job.rows[0];
  if (!row) return { status: 404, body: { error: `Unknown job ${jobId}.` } };
  const parsed = rowToJob(row);
  const log = await readJobLog(deps.engine.git, {
    worktreePath: parsed.worktreePath,
    branch: parsed.branch,
    baseSha: typeof parsed.metadata.baseSha === 'string' ? parsed.metadata.baseSha : null,
  });
  if ('gone' in log && log.gone) return { status: 200, body: { gone: true } };
  return { status: 200, body: log as Record<string, unknown> };
}

export async function opConfigPut(deps: RouteDeps, body: unknown): Promise<OpResult> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: 'Body must be a JSON object.' } };
  }
  const input = body as Record<string, unknown>;
  const upserts: Array<{ key: string; value: unknown }> = [];
  if (input.systemPrompt !== undefined) {
    if (typeof input.systemPrompt !== 'string' || input.systemPrompt.length > 100_000) {
      return { status: 400, body: { error: 'systemPrompt must be a string ≤ 100000 chars.' } };
    }
    upserts.push({ key: 'systemPrompt', value: input.systemPrompt });
  }
  if (input.defaults !== undefined) {
    if (!input.defaults || typeof input.defaults !== 'object' || Array.isArray(input.defaults)) {
      return { status: 400, body: { error: 'defaults must be an object.' } };
    }
    upserts.push({ key: 'defaults', value: input.defaults });
  }
  if (input.models !== undefined) {
    if (!Array.isArray(input.models) || input.models.length > 20) {
      return { status: 400, body: { error: 'models must be an array of ≤ 20 entries.' } };
    }
    for (const entry of input.models) {
      if (typeof entry !== 'string' || !parseModelRef(entry)) {
        return { status: 400, body: { error: `models entries must be 'provider/model' strings (got ${JSON.stringify(entry)}).` } };
      }
    }
    upserts.push({ key: 'models', value: input.models.map((entry) => entry.trim()) });
  }
  for (const upsert of upserts) {
    await deps.pool.query(
      `INSERT INTO executor.config (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [upsert.key, JSON.stringify(upsert.value)]);
  }
  return { status: 200, body: { ok: true } };
}

/* — Gateway protocol dispatch — */

export const GATEWAY_PROTOCOL_VERSION = 'nexus.executor.v1';

/** The canonical operation set; MUST match the gateway's protocol adapter
 *  (nexus-gateway src/protocol/nexus.ts) exactly — divergence fails loudly
 *  at the gateway boundary (unknown operation → connection rejected). */
const ID_OPS = ['job.get', 'job.cancel', 'job.verify', 'job.merge', 'job.log'] as const;
type IdOp = (typeof ID_OPS)[number];

function textArg(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

type GatewayResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string; status: number; details?: Record<string, unknown> };

/**
 * Execute one canonical gateway request; the {ok,result}/{ok,error,status}
 * envelope is the protocol's response payload. Unknown/malformed payloads
 * answer {ok:false} (never throw): one bad message must not drop the loop.
 */
export async function handleGatewayOperation(
  deps: RouteDeps, operation: string, payload: unknown,
): Promise<GatewayResponse> {
  const wrap = (result: OpResult): GatewayResponse => {
    if (result.status >= 200 && result.status < 300) return { ok: true, result: result.body };
    const error = typeof result.body.error === 'string' ? result.body.error : `Operation failed (${result.status})`;
    const { error: _error, ...details } = result.body;
    return Object.keys(details).length
      ? { ok: false, error, status: result.status, details }
      : { ok: false, error, status: result.status };
  };
  const body = (payload ?? {}) as Record<string, unknown>;
  try {
    switch (operation) {
      case 'status.get':
        return wrap(await opStatus(deps));
      case 'models.list':
        return wrap(await opModels(deps, typeof body.directory === 'string' ? body.directory : undefined));
      case 'config.put':
        return wrap(await opConfigPut(deps, payload));
      case 'job.dispatch': {
        // The canonical spec arrives wrapped: {job: <RemoteJobSpec>}.
        const spec = (payload ?? {}) as Record<string, unknown>;
        if (!spec || typeof spec !== 'object' || !('job' in spec)) {
          return { ok: false, error: 'job.dispatch payload must be {job: RemoteJobSpec}.', status: 400 };
        }
        return wrap(await opCreateJob(deps, spec.job));
      }
      case 'job.events': {
        const jobId = textArg(body.jobId, 200);
        const sinceSeq = body.sinceSeq;
        const limit = body.limit;
        if (!jobId || typeof sinceSeq !== 'number' || !Number.isInteger(sinceSeq) || sinceSeq < 0
          || typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 500) {
          return { ok: false, error: 'job.events payload must be {jobId, sinceSeq >= 0, limit 1..500}.', status: 400 };
        }
        return wrap(await opJobEvents(deps, jobId, sinceSeq, limit));
      }
      case 'job.message': {
        const jobId = textArg(body.jobId, 200);
        const text = body.text;
        if (!jobId || typeof text !== 'string' || !text.trim() || text.length > 50_000) {
          return { ok: false, error: 'job.message payload must be {jobId, text 1..50000 chars}.', status: 400 };
        }
        return wrap(await opJobMessage(deps, jobId, text));
      }
      default: {
        if ((ID_OPS as readonly string[]).includes(operation)) {
          const jobId = textArg(body.jobId, 200);
          if (!jobId) return { ok: false, error: `${operation} payload must be {jobId}.`, status: 400 };
          const op = operation as IdOp;
          if (op === 'job.get') return wrap(await opShowJob(deps, jobId));
          if (op === 'job.cancel') return wrap(await opJobCancel(deps, jobId));
          if (op === 'job.verify') return wrap(await opJobVerify(deps, jobId));
          if (op === 'job.merge') return wrap(await opJobMerge(deps, jobId));
          return wrap(await opJobLog(deps, jobId));
        }
        return { ok: false, error: `Unknown operation ${operation}.`, status: 400 };
      }
    }
  } catch (error) {
    // Dependency-level failure (database, git, …): a 503, no internals.
    return { ok: false, error: 'Executor dependency unavailable.', status: 503 };
  }
}

/** Health-probe pairing state for /health (unchanged HTTP listen mode). */
export async function healthPaired(deps: RouteDeps): Promise<{ ok: boolean; db: 'up' | 'down'; paired: boolean }> {
  try {
    await deps.pool.query('SELECT 1');
    return { ok: true, db: 'up', paired: (await readAuthConfig(deps.pool)) !== null };
  } catch {
    return { ok: false, db: 'down', paired: false };
  }
}
