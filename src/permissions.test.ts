import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createPool, defaultMigrationsDir, runModuleMigrations } from './db.js';
import { JobEngine } from './engine.js';
import { createOpenCodeClient } from './opencode.js';
import { testConfig, wipeJobs } from './testkit.js';
import { applyJobPermissions, updateJobPermissions } from './permissions.js';

const pool = createPool(process.env.DATABASE_URL!);
const policy = { revision: 'r1', generation: 1, rules: [{ action: '*', resource: '*', effect: 'deny' as const }] };
let patches: string[] = [];
let failPatch = false;
let stored: unknown = [];
const client = createOpenCodeClient({ baseUrl: 'http://stub', fetchImpl: async (url, init) => {
  if (init?.method === 'PATCH') {
    if (failPatch) return new Response('unavailable', { status: 503 });
    patches.push(String(url)); stored = JSON.parse(String(init.body)).permissions;
    return new Response(null, { status: 204 });
  }
  return Response.json({ data: { id: String(url).split('/').at(-1), permissions: stored } });
} });
beforeAll(async () => { await runModuleMigrations(pool, 'executor', 'executor', defaultMigrationsDir()); });
beforeEach(async () => {
  await wipeJobs(pool); patches = []; failPatch = false; stored = [];
  const engine = new JobEngine({ pool, config: testConfig('/tmp/opencode/permissions-test'), client: null });
  await engine.createJob({ jobId: 'policy-job', title: 'policy', prompt: 'work', verificationCommand: '', project: null, models: [], attachments: [] });
});
afterAll(async () => { await pool.end(); });
async function session(id: string) {
  await pool.query("UPDATE executor.jobs SET status = 'running', opencode_session_id = $1 WHERE hub_job_id = 'policy-job'", [id]);
}
it('queues desired policy, patches running session without interruption, and deduplicates acknowledgments', async () => {
  expect(await updateJobPermissions(pool, client, 'policy-job', policy)).toEqual({ revision: 'r1', generation: 1, sessionId: null, applied: false });
  await session('ses_one');
  expect(await applyJobPermissions(pool, client, 'policy-job')).toEqual({ revision: 'r1', generation: 1, sessionId: 'ses_one', applied: true });
  await updateJobPermissions(pool, client, 'policy-job', policy);
  expect(patches).toEqual(['http://stub/api/session/ses_one']);
  expect(stored).toEqual(policy.rules);
});
it('rejects stale generations and equal-generation conflicts', async () => {
  await updateJobPermissions(pool, client, 'policy-job', { ...policy, generation: 2 });
  await expect(updateJobPermissions(pool, client, 'policy-job', policy)).rejects.toMatchObject({ status: 409 });
  await expect(updateJobPermissions(pool, client, 'policy-job', { ...policy, generation: 2, revision: 'other' })).rejects.toMatchObject({ status: 409 });
});

it('repairs live session override drift even when generation and acknowledgment are unchanged', async () => {
  await session('ses_one');
  await updateJobPermissions(pool, client, 'policy-job', policy);
  stored = [{ action: '*', resource: '*', effect: 'allow' }];
  expect(await updateJobPermissions(pool, client, 'policy-job', policy)).toMatchObject({ generation: 1, applied: true });
  expect(stored).toEqual(policy.rules);
  expect(patches).toEqual(['http://stub/api/session/ses_one', 'http://stub/api/session/ses_one']);
  // Once repaired, unchanged live rules avoid another PATCH.
  await updateJobPermissions(pool, client, 'policy-job', policy);
  expect(patches).toHaveLength(2);
});
it('persists desired policy through network failure and reapplies to replacement sessions', async () => {
  await session('ses_one'); failPatch = true;
  await expect(updateJobPermissions(pool, client, 'policy-job', policy)).rejects.toThrow();
  expect((await pool.query('SELECT permission_policy FROM executor.jobs')).rows[0].permission_policy).toEqual(policy);
  failPatch = false;
  await applyJobPermissions(pool, client, 'policy-job');
  await session('ses_two');
  await applyJobPermissions(pool, client, 'policy-job');
  expect(patches).toEqual(['http://stub/api/session/ses_one', 'http://stub/api/session/ses_two']);
});
it('refuses malformed rules and terminal targets', async () => {
  for (const bad of [{ ...policy, generation: 0 }, { ...policy, sessionId: 'attacker' }, { ...policy, rules: [{ action: '*', resource: '*', effect: 'yes' }] }]) {
    await expect(updateJobPermissions(pool, client, 'policy-job', bad)).rejects.toMatchObject({ status: 400 });
  }
  await pool.query("UPDATE executor.jobs SET status = 'cancelled'");
  await expect(updateJobPermissions(pool, client, 'policy-job', policy)).rejects.toMatchObject({ status: 409 });
  expect(patches).toEqual([]);
});

it('serializes concurrent updates so the final session policy and acknowledgment cannot move backwards', async () => {
  await session('ses_one');
  let release!: () => void;
  let entered!: () => void;
  const enteredPatch = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const order: unknown[] = [];
  let observed: unknown;
  const slow = createOpenCodeClient({ baseUrl: 'http://stub', fetchImpl: async (_url, init) => {
    if (init?.method === 'PATCH') {
      observed = JSON.parse(String(init.body)).permissions;
      order.push(observed);
      if (order.length === 1) { entered(); await blocked; }
      return new Response(null, { status: 204 });
    }
    return Response.json({ data: { permissions: observed } });
  } });
  const first = updateJobPermissions(pool, slow, 'policy-job', policy);
  await enteredPatch;
  const newer = { revision: 'r2', generation: 2, rules: [...policy.rules, { action: 'read', resource: '*', effect: 'allow' as const }] };
  const second = updateJobPermissions(pool, slow, 'policy-job', newer);
  release();
  expect(await first).toMatchObject({ generation: 1, applied: true });
  expect(await second).toMatchObject({ generation: 2, applied: true });
  expect(order).toEqual([policy.rules, newer.rules]);
  expect((await pool.query('SELECT permission_applied FROM executor.jobs')).rows[0].permission_applied).toMatchObject({ generation: 2, applied: true });
});

it('never acknowledges failed readback and fences a stale session or attempt before PATCH', async () => {
  await updateJobPermissions(pool, client, 'policy-job', policy);
  await session('ses_two');
  await expect(applyJobPermissions(pool, client, 'policy-job', { sessionId: 'ses_old', attempt: 1 })).rejects.toMatchObject({ status: 409 });
  await expect(applyJobPermissions(pool, client, 'policy-job', { sessionId: 'ses_two', attempt: 999 })).rejects.toMatchObject({ status: 409 });
  expect(patches).toEqual([]);
  const wrong = createOpenCodeClient({ baseUrl: 'http://stub', fetchImpl: async (_url, init) => init?.method === 'PATCH'
    ? new Response(null, { status: 204 }) : Response.json({ data: { permissions: [] } }) });
  await expect(applyJobPermissions(pool, wrong, 'policy-job')).rejects.toMatchObject({ status: 502 });
  expect((await pool.query('SELECT permission_applied FROM executor.jobs')).rows[0].permission_applied).toBeNull();
});
