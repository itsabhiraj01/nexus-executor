import type { Pool, PoolClient } from 'pg';
import { homedir } from 'node:os';
import { OpenCodeError, type OpenCodeClient, type OpenCodePermissionRequest } from './opencode.js';
import { PermissionPolicyError } from './permissions.js';

export interface PermissionDecision {
  decisionId: string; attempt: number; sessionId: string; requestId: string; decision: 'once' | 'reject';
}
export interface ManualApprovalSnapshot {
  waiting: boolean; attempt: number; sessionId: string | null;
  requests: Array<{ id: string; action: string; resources: string[] }>;
  resolved: Array<{ id: string; outcome: 'delivered' | 'expired' | 'cancelled' }>;
}
interface Job {
  permission_policy: { rules:unknown } | null;
  spec: { manualApprovals?: boolean };
  id: string; status: string; attempt_count: number; opencode_session_id: string | null;
  metadata: Record<string, unknown>;
}
const terminal = (job: Job) => ['failed','succeeded','cancelled','queued'].includes(job.status);
const active = "state IN ('pending','decision_recorded')";

function wildcard(pattern:string,resource:string):boolean {
  let p=0,r=0,star=-1,retry=0;
  while (r<resource.length) {
    if (pattern[p] === '*') { star=p++;retry=r; }
    else if (pattern[p] === '?' || pattern[p] === resource[r]) { p++;r++; }
    else if (star !== -1) { p=star+1;r=++retry; }
    else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

/** Mirror V2 documented configured-rule matching ON THE EXECUTOR HOST.
 * The hub's overlay is deny-all first, so missing/unreadable rules fail closed.
 * https://opencode.ai/v2/docs/permissions (not the deprecated V1 matcher).
 */
function allowedByOverlay(input:unknown,action:string,resources:string[]):boolean {
  if (!Array.isArray(input) || !resources.length) return false;
  const paths = ['read','edit','external_directory'].includes(action);
  const normalize = (value:string) => {
    let out = paths ? value.replace(/^(?:~|\$HOME)(?=$|[\\/])/,homedir()).replaceAll('\\','/') : value;
    if (process.platform === 'win32') out = out.toLowerCase();
    return out;
  };
  return resources.every(resource => {
    let effect = 'deny';
    for (const value of input) {
      if (!value || typeof value !== 'object' || typeof value.action !== 'string' || typeof value.resource !== 'string' || !['allow','deny','ask'].includes(value.effect)) return false;
      const pattern = normalize(value.resource),candidate = normalize(resource);
      if (wildcard(value.action,action) && (wildcard(pattern,candidate) || (action === 'shell' && pattern.endsWith(' *') && candidate === pattern.slice(0,-2)))) effect = value.effect;
    }
    return effect !== 'deny';
  });
}

export function parsePermissionDecision(input: unknown): PermissionDecision {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PermissionPolicyError(400, 'Invalid permission decision.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(k => !['decisionId','attempt','sessionId','requestId','decision'].includes(k)) ||
    !Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1 ||
    !['decisionId','sessionId','requestId'].every(k => typeof value[k] === 'string' && (value[k] as string).length > 0 && (value[k] as string).length <= 200 && !/[\x00-\x1f\x7f]/.test(value[k] as string)) ||
    (value.decision !== 'once' && value.decision !== 'reject')) throw new PermissionPolicyError(400, 'Invalid permission decision.');
  return value as unknown as PermissionDecision;
}

async function locked<T>(pool: Pool, id: string, byHub: boolean, run: (db: PoolClient, job: Job) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const job = (await db.query<Job>(`SELECT * FROM executor.jobs WHERE ${byHub ? 'hub_job_id' : 'id'}=$1 FOR UPDATE`, [id])).rows[0];
    if (!job) throw new PermissionPolicyError(404, 'Unknown job.');
    const result = await run(db, job);
    await db.query('COMMIT');
    return result;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

/** Clock state is persisted with the inbox, before the hub can observe it. */
async function updateWaiting(db: PoolClient, job: Job, waiting: boolean): Promise<void> {
  const since = typeof job.metadata.permissionWaitStartedAt === 'number' ? job.metadata.permissionWaitStartedAt : null;
  const now = Date.now();
  const patch = waiting
    ? { permissionWaitStartedAt: since ?? now }
    : { permissionWaitStartedAt: null, permissionWaitMs: Number(job.metadata.permissionWaitMs ?? 0) + (since === null ? 0 : Math.max(0, now - since)),
      ...(since === null ? {} : { permissionResumedAt: now, toolFingerprints: {} }) };
  await db.query('UPDATE executor.jobs SET metadata=metadata || $2::jsonb, updated_at=now() WHERE id=$1', [job.id, JSON.stringify(patch)]);
}

async function reconcileLocked(db: PoolClient, client: OpenCodeClient | null, job: Job): Promise<boolean> {
  if (!job.spec.manualApprovals) return false;
  await db.query(`UPDATE executor.manual_approvals SET state=$2,updated_at=now() WHERE job_id=$1 AND ${active}
    AND (attempt<>$3 OR session_id IS DISTINCT FROM $4 OR $5)`, [job.id, job.status === 'cancelled' ? 'cancelled' : 'expired', job.attempt_count, job.opencode_session_id, terminal(job)]);
  if (terminal(job) || !job.opencode_session_id) { await updateWaiting(db, job, false); return false; }
  if (!client) {
    const waiting = (await db.query(`SELECT 1 FROM executor.manual_approvals WHERE job_id=$1 AND ${active} LIMIT 1`, [job.id])).rowCount! > 0;
    if (waiting) await updateWaiting(db, job, true);
    return waiting;
  }
  let requests: OpenCodePermissionRequest[];
  try { requests = await client.listPermissionRequests(job.opencode_session_id); }
  catch (error) {
    if (!(error instanceof OpenCodeError && error.status === 404)) throw error; // outage is NOT disappearance
    requests = [];
  }
  // Runtime identity is the authority. Never use suggested save wildcards.
  for (const request of requests) {
    if (!request.id || (request.sessionID && request.sessionID !== job.opencode_session_id)) continue;
    if (!request.action || !Array.isArray(request.resources) || !request.resources.every(r => typeof r === 'string')) {
      throw new PermissionPolicyError(502, 'Runtime permission request lacks exact action/resources.');
    }
    await db.query(`INSERT INTO executor.manual_approvals (job_id,attempt,session_id,request_id,action,resources)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`, [job.id,job.attempt_count,job.opencode_session_id,request.id,request.action,JSON.stringify(request.resources)]);
  }
  await db.query(`UPDATE executor.manual_approvals SET state='expired',updated_at=now() WHERE job_id=$1 AND attempt=$2 AND session_id=$3
    AND ${active} AND NOT(request_id=ANY($4::text[]))`, [job.id,job.attempt_count,job.opencode_session_id,requests.map(r => r.id)]);
  const waiting = requests.length > 0;
  await db.query('UPDATE executor.jobs SET metadata=metadata || $2::jsonb WHERE id=$1',[job.id,JSON.stringify({ permissionRuntimeRequestIds:requests.map(r => r.id),permissionRuntimeAttempt:job.attempt_count,permissionRuntimeSessionId:job.opencode_session_id })]);
  await updateWaiting(db, job, waiting);
  return waiting;
}

export async function reconcileManualApprovals(pool: Pool, client: OpenCodeClient | null, jobId: string): Promise<boolean> {
  return locked(pool, jobId, false, (db,job) => reconcileLocked(db,client,job));
}

export async function manualApprovalSnapshot(pool: Pool, jobId: string): Promise<ManualApprovalSnapshot> {
  return locked(pool, jobId, false, async (db,job) => {
    // Terminal/replacement invalidation needs no reachable OpenCode runtime.
    await db.query(`UPDATE executor.manual_approvals SET state=$2,updated_at=now() WHERE job_id=$1 AND ${active}
      AND (attempt<>$3 OR session_id IS DISTINCT FROM $4 OR $5)`, [job.id,job.status === 'cancelled' ? 'cancelled' : 'expired',job.attempt_count,job.opencode_session_id,terminal(job)]);
    const rows = (await db.query<{ request_id: string; action: string; resources: string[]; state: string }>(
      'SELECT * FROM executor.manual_approvals WHERE job_id=$1 AND attempt=$2 AND session_id=$3 ORDER BY created_at', [job.id,job.attempt_count,job.opencode_session_id])).rows;
    const runtimeIds = terminal(job) || job.metadata.permissionRuntimeAttempt !== job.attempt_count || job.metadata.permissionRuntimeSessionId !== job.opencode_session_id
      ? [] : (Array.isArray(job.metadata.permissionRuntimeRequestIds) ? job.metadata.permissionRuntimeRequestIds : []);
    return { waiting: !terminal(job) && (runtimeIds.length > 0 || rows.some(r => ['pending','decision_recorded'].includes(r.state))), attempt: job.attempt_count, sessionId: job.opencode_session_id,
      requests: rows.filter(r => !terminal(job) && (runtimeIds.includes(r.request_id) || ['pending','decision_recorded'].includes(r.state))).map(r => ({ id:r.request_id,action:r.action,resources:r.resources })),
      resolved: rows.filter(r => ['delivered','expired','cancelled'].includes(r.state)).map(r => ({ id:r.request_id,outcome:r.state as 'delivered'|'expired'|'cancelled' })) };
  });
}

/** Template-learning preflight: cached job detail is not evidence of a live ask. */
export async function freshManualApprovalSnapshot(pool:Pool,client:OpenCodeClient|null,hubJobId:string):Promise<ManualApprovalSnapshot> {
  const jobId = await locked(pool,hubJobId,true,async (db,job) => {
    if (!client) throw new PermissionPolicyError(502,'Runtime unavailable; pending permissions cannot be verified.');
    try { await reconcileLocked(db,client,job); }
    catch (error) {
      if (error instanceof PermissionPolicyError) throw error;
      throw new PermissionPolicyError(502,'Runtime unavailable; pending permissions cannot be verified.');
    }
    return job.id;
  });
  return manualApprovalSnapshot(pool,jobId);
}

export async function decidePermission(pool: Pool, client: OpenCodeClient | null, hubJobId: string, input: unknown): Promise<{ decisionId: string; outcome: 'delivered' | 'expired' }> {
  const value = parsePermissionDecision(input);
  // Commit decision before transport. Replays use durable identity, not the gateway's process cache.
  const delivered = await locked(pool, hubJobId, true, async (db,job) => {
    const row = (await db.query(`SELECT * FROM executor.manual_approvals WHERE job_id=$1 AND attempt=$2 AND session_id=$3 AND request_id=$4`, [job.id,value.attempt,value.sessionId,value.requestId])).rows[0];
    if (row?.state === 'delivered' && row.decision_id === value.decisionId && row.decision === value.decision) return true;
    if (terminal(job) || job.attempt_count !== value.attempt || job.opencode_session_id !== value.sessionId) throw new PermissionPolicyError(409,'Permission attempt/session changed.');
    if (!row || ['expired','cancelled'].includes(row.state)) throw new PermissionPolicyError(409,'Permission request expired.');
    if (row.decision_id && (row.decision_id !== value.decisionId || row.decision !== value.decision)) throw new PermissionPolicyError(409,'Conflicting permission decision.');
    const used = (await db.query('SELECT job_id,attempt,session_id,request_id FROM executor.manual_approvals WHERE decision_id=$1',[value.decisionId])).rows[0];
    if (used && (used.job_id !== job.id || used.attempt !== value.attempt || used.session_id !== value.sessionId || used.request_id !== value.requestId)) throw new PermissionPolicyError(409,'Decision ID already belongs to another request.');
    await db.query(`UPDATE executor.manual_approvals SET decision_id=$5,decision=$6,state=CASE WHEN state='pending' THEN 'decision_recorded' ELSE state END,updated_at=now()
      WHERE job_id=$1 AND attempt=$2 AND session_id=$3 AND request_id=$4`, [job.id,value.attempt,value.sessionId,value.requestId,value.decisionId,value.decision]);
    return false;
  });
  if (delivered) return { decisionId:value.decisionId,outcome:'delivered' };
  let reconciledJobId = '';
  const result = await locked(pool, hubJobId, true, async (db,job):Promise<{ decisionId:string;outcome:'delivered'|'expired' }> => {
    reconciledJobId = job.id;
    const row = (await db.query('SELECT * FROM executor.manual_approvals WHERE decision_id=$1', [value.decisionId])).rows[0];
    if (row?.state === 'delivered' && row.job_id === job.id && row.attempt === value.attempt && row.session_id === value.sessionId && row.request_id === value.requestId && row.decision === value.decision) return { decisionId:value.decisionId,outcome:'delivered' };
    if (terminal(job) || job.attempt_count !== value.attempt || job.opencode_session_id !== value.sessionId) throw new PermissionPolicyError(409,'Permission attempt/session changed.');
    if (!client) throw new PermissionPolicyError(503,'OpenCode unavailable; decision is recorded.');
    let requests:OpenCodePermissionRequest[];
    try { requests = await client.listPermissionRequests(value.sessionId); }
    catch (error) { if (error instanceof OpenCodeError && error.status === 404) requests = []; else throw error; }
    if (!requests.some(r => r.id === value.requestId)) {
      await reconcileLocked(db,client,job);
      return { decisionId:value.decisionId,outcome:'expired' }; // never claim a lost acknowledgment resumed a tool
    }
    const current = requests.find(r => r.id === value.requestId)!;
    if (current.action !== row.action || JSON.stringify(current.resources) !== JSON.stringify(row.resources)) throw new PermissionPolicyError(409,'Runtime permission resources changed.');
    if (value.decision === 'once') {
      const live = await client.getSessionPermissions(value.sessionId);
      if (!allowedByOverlay(live,row.action,row.resources)
        || (job.permission_policy && !allowedByOverlay(job.permission_policy.rules,row.action,row.resources))) {
        throw new PermissionPolicyError(409,'The current executor permission policy denies this request or cannot be verified.');
      }
    }
    await client.replyPermission(value.sessionId,value.requestId,value.decision,value.decision === 'reject' ? 'The run owner rejected this permission request.' : undefined);
    await db.query("UPDATE executor.manual_approvals SET state='delivered',updated_at=now() WHERE decision_id=$1", [value.decisionId]);
    return { decisionId:value.decisionId,outcome:'delivered' };
  });
  // Commit the receipt BEFORE sibling readback. A transient readback failure
  // must never erase proof that the original runtime reply succeeded.
  if (result.outcome === 'delivered') await reconcileManualApprovals(pool,client,reconciledJobId).catch(() => {});
  return result;
}

export function activeElapsed(job: { startedAt: Date | null; metadata: Record<string,unknown> }, now: number): number {
  if (!job.startedAt) return 0;
  const since = typeof job.metadata.permissionWaitStartedAt === 'number' ? job.metadata.permissionWaitStartedAt : now;
  return Math.max(0, now-job.startedAt.getTime()-Number(job.metadata.permissionWaitMs ?? 0)-Math.max(0,now-since));
}
