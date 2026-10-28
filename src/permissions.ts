import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import type { OpenCodeClient } from './opencode.js';

export interface RemotePermissionPolicy {
  revision: string;
  generation: number;
  rules: Array<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }>;
}
export interface PermissionAcknowledgment {
  revision: string; generation: number; sessionId: string | null; applied: boolean;
}
export class PermissionPolicyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new PermissionPolicyError(400, 'Invalid permission policy object.');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new PermissionPolicyError(400, 'Invalid permission policy string.');
  }
  return value;
}
export function parsePermissionPolicy(input: unknown): RemotePermissionPolicy {
  const value = exact(input, ['revision', 'generation', 'rules']);
  const revision = text(value.revision, 128);
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1 || !Array.isArray(value.rules) || value.rules.length < 1 || value.rules.length > 256) {
    throw new PermissionPolicyError(400, 'Invalid permission generation or rules.');
  }
  const rules = value.rules.map((entry): RemotePermissionPolicy['rules'][number] => {
    const rule = exact(entry, ['action', 'resource', 'effect']);
    if (rule.effect !== 'allow' && rule.effect !== 'deny' && rule.effect !== 'ask') throw new PermissionPolicyError(400, 'Invalid permission effect.');
    return { action: text(rule.action, 200), resource: text(rule.resource, 2000), effect: rule.effect };
  });
  return { revision, generation: value.generation as number, rules };
}
interface PolicyRow {
  id: string; status: string; attempt_count: number; opencode_session_id: string | null;
  permission_policy: RemotePermissionPolicy | null;
  permission_applied: (PermissionAcknowledgment & { attempt: number }) | null;
}
const terminal = (row: PolicyRow) => ['failed', 'succeeded', 'cancelled'].includes(row.status);
async function locked<T>(pool: Pool, jobId: string, run: (db: PoolClient, row: PolicyRow) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const row = (await db.query<PolicyRow>('SELECT * FROM executor.jobs WHERE hub_job_id = $1 FOR UPDATE', [jobId])).rows[0];
    if (!row) throw new PermissionPolicyError(404, 'Unknown job.');
    const result = await run(db, row);
    await db.query('COMMIT');
    return result;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

/** Commit desire separately: a network failure must not lose the next retry's policy. */
export async function updateJobPermissions(pool: Pool, client: OpenCodeClient | null, jobId: string, input: unknown): Promise<PermissionAcknowledgment> {
  const policy = parsePermissionPolicy(input);
  await locked(pool, jobId, async (db, row) => {
    if (terminal(row)) throw new PermissionPolicyError(409, 'Job is terminal.');
    const previous = row.permission_policy;
    if (previous && (previous.generation > policy.generation || (previous.generation === policy.generation && !isDeepStrictEqual(previous, policy)))) {
      throw new PermissionPolicyError(409, 'Stale or conflicting permission generation.');
    }
    if (!previous || previous.generation !== policy.generation) {
      await db.query('UPDATE executor.jobs SET permission_policy = $2::jsonb, permission_applied = NULL WHERE id = $1', [row.id, JSON.stringify(policy)]);
    }
  });
  // Another update may have won between transactions: return the actual current acknowledgment.
  return (await applyJobPermissions(pool, client, jobId))!;
}

/** Row ownership spans PATCH/readback/ack. Lifecycle session/attempt changes and
 * terminal writes cannot race this acknowledgment; no runner restart is involved. */
export async function applyJobPermissions(pool: Pool, client: OpenCodeClient | null, jobId: string,
  expected?: { sessionId: string; attempt: number }): Promise<PermissionAcknowledgment | null> {
  return locked(pool, jobId, async (db, row) => {
    if (expected && (row.opencode_session_id !== expected.sessionId || row.attempt_count !== expected.attempt || terminal(row) || row.status === 'queued')) {
      throw new PermissionPolicyError(409, 'Permission target attempt changed.');
    }
    const policy = row.permission_policy;
    if (!policy) return null;
    if (terminal(row)) throw new PermissionPolicyError(409, 'Job is terminal.');
    const ack: PermissionAcknowledgment = { revision: policy.revision, generation: policy.generation, sessionId: row.opencode_session_id, applied: false };
    if (!row.opencode_session_id || row.status === 'queued') return ack;
    if (!client) throw new PermissionPolicyError(503, 'OpenCode is not configured.');
    const old = row.permission_applied;
    if (old?.applied && old.generation === policy.generation && old.revision === policy.revision && old.sessionId === row.opencode_session_id && old.attempt === row.attempt_count) {
      // An acknowledgment describes a past write, not current authority: users
      // or integrations may have replaced the session overlay since then.
      const live = await client.getSessionPermissions(row.opencode_session_id);
      if (isDeepStrictEqual(live, policy.rules)) return { ...ack, applied: true };
    }
    await client.setSessionPermissions(row.opencode_session_id, policy.rules);
    const observed = await client.getSessionPermissions(row.opencode_session_id);
    if (!isDeepStrictEqual(observed, policy.rules)) throw new PermissionPolicyError(502, 'OpenCode permission readback did not match.');
    ack.applied = true;
    await db.query('UPDATE executor.jobs SET permission_applied = $2::jsonb WHERE id = $1', [row.id, JSON.stringify({ ...ack, attempt: row.attempt_count })]);
    return ack;
  });
}
