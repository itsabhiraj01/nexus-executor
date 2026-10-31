import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { createPool, defaultMigrationsDir, runModuleMigrations } from './db.js';
import { makeStubClient } from './testkit.js';
import { reconcileManualApprovals, decidePermission, manualApprovalSnapshot, activeElapsed } from './manual-approvals.js';

let pool: Pool;
beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL!);
  await pool.query('DROP SCHEMA IF EXISTS executor CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS platform CASCADE');
  await runModuleMigrations(pool, 'executor', 'executor', defaultMigrationsDir());
});
afterAll(async () => { await pool.end(); });

it('persists waiting before publication, delivers the original request once and replays durably', async () => {
  const { client, state } = makeStubClient();
  const session = await client.createSession({ title: 'approval', directory: '/tmp/opencode' });
  await client.setSessionPermissions(session.id,[{ action:'bash',resource:'*',effect:'ask' }]);
  const row = (await pool.query(`INSERT INTO executor.jobs (hub_job_id,spec,status,opencode_session_id,attempt_count,started_at)
    VALUES ('approval','{"manualApprovals":true}','running',$1,1,now()) RETURNING *`, [session.id])).rows[0];
  state.permissionRequests[session.id] = [{ id: 'req1', action: 'bash', resources: ['git status'] }];
  expect(await reconcileManualApprovals(pool, client, row.id)).toBe(true);
  expect((await manualApprovalSnapshot(pool, row.id)).requests).toEqual([{ id: 'req1', action: 'bash', resources: ['git status'] }]);
  expect(state.permissionReplies).toEqual([]);
  const decision = { decisionId: 'decision1', attempt: 1, sessionId: session.id, requestId: 'req1', decision: 'once' as const };
  expect(await decidePermission(pool, client, 'approval', decision)).toEqual({ decisionId: 'decision1', outcome: 'delivered' });
  expect(await decidePermission(pool, client, 'approval', decision)).toEqual({ decisionId: 'decision1', outcome: 'delivered' });
  expect(state.permissionReplies).toHaveLength(1);
  expect((await manualApprovalSnapshot(pool, row.id)).waiting).toBe(false);
  await expect(decidePermission(pool, client, 'approval', { ...decision, attempt: 2 })).rejects.toMatchObject({ status: 409 });
});

it('refuses once after the current runtime overlay changes to deny', async () => {
  const { client,state } = makeStubClient();
  const session = await client.createSession({ title:'deny',directory:'/tmp/opencode' });
  await client.setSessionPermissions(session.id,[{ action:'shell',resource:'*',effect:'ask' }]);
  const row = (await pool.query(`INSERT INTO executor.jobs (hub_job_id,spec,status,opencode_session_id,attempt_count)
    VALUES ('deny','{"manualApprovals":true}','running',$1,1) RETURNING *`,[session.id])).rows[0];
  state.permissionRequests[session.id] = [{ id:'blocked',action:'shell',resources:['git push'] }];
  await reconcileManualApprovals(pool,client,row.id);
  await client.setSessionPermissions(session.id,[{ action:'shell',resource:'*',effect:'ask' },{ action:'shell',resource:'git push *',effect:'deny' }]);
  await expect(decidePermission(pool,client,'deny',{ decisionId:'blocked-d',attempt:1,sessionId:session.id,requestId:'blocked',decision:'once' })).rejects.toMatchObject({ status:409 });
  expect(state.permissionReplies).toEqual([]);
  await pool.query("UPDATE executor.manual_approvals SET state='expired' WHERE request_id='blocked'");
  expect(await reconcileManualApprovals(pool,client,row.id)).toBe(true);
  expect((await manualApprovalSnapshot(pool,row.id)).waiting).toBe(true);
});

it('expires missing runtime requests and rejects stale decisions without replaying tools', async () => {
  const { client, state } = makeStubClient();
  const session = await client.createSession({ title: 'lost', directory: '/tmp/opencode' });
  const row = (await pool.query(`INSERT INTO executor.jobs (hub_job_id,spec,status,opencode_session_id,attempt_count)
    VALUES ('lost','{"manualApprovals":true}','running',$1,1) RETURNING *`, [session.id])).rows[0];
  state.permissionRequests[session.id] = [{ id: 'req2', action: 'bash', resources: ['pwd'] }];
  await reconcileManualApprovals(pool, client, row.id);
  state.permissionRequests[session.id] = [];
  await reconcileManualApprovals(pool, client, row.id);
  expect((await manualApprovalSnapshot(pool, row.id)).resolved).toContainEqual({ id: 'req2', outcome: 'expired' });
  await expect(decidePermission(pool, client, 'lost', { decisionId: 'late', attempt: 1, sessionId: session.id, requestId: 'req2', decision: 'once' })).rejects.toMatchObject({ status: 409 });
  expect(state.permissionReplies).toEqual([]);
});

it('retains a recorded decision through runtime outage and retries only its original request', async () => {
  const { client,state } = makeStubClient();
  const session = await client.createSession({ title:'offline',directory:'/tmp/opencode' });
  await client.setSessionPermissions(session.id,[{ action:'shell',resource:'*',effect:'ask' }]);
  const row = (await pool.query(`INSERT INTO executor.jobs (hub_job_id,spec,status,opencode_session_id,attempt_count)
    VALUES ('offline','{"manualApprovals":true}','running',$1,1) RETURNING *`,[session.id])).rows[0];
  state.permissionRequests[session.id] = [{ id:'offline-r',action:'shell',resources:['pwd'] },{ id:'other',action:'shell',resources:['git status'] }];
  await reconcileManualApprovals(pool,client,row.id);
  const decision = { decisionId:'offline-d',attempt:1,sessionId:session.id,requestId:'offline-r',decision:'once' as const };
  const outage = vi.spyOn(client,'replyPermission').mockRejectedValueOnce(new Error('network unavailable'));
  await expect(decidePermission(pool,client,'offline',decision)).rejects.toThrow('network unavailable');
  expect((await pool.query("SELECT state,decision_id FROM executor.manual_approvals WHERE request_id='offline-r'")).rows[0]).toEqual({ state:'decision_recorded',decision_id:'offline-d' });
  expect((await manualApprovalSnapshot(pool,row.id)).waiting).toBe(true);
  outage.mockRestore();
  expect(await decidePermission(pool,client,'offline',decision)).toEqual({ decisionId:'offline-d',outcome:'delivered' });
  expect(state.permissionReplies).toHaveLength(1);
  expect((await manualApprovalSnapshot(pool,row.id)).requests).toEqual([{ id:'other',action:'shell',resources:['git status'] }]);
  await pool.query("UPDATE executor.jobs SET status='cancelled' WHERE id=$1",[row.id]);
  expect((await manualApprovalSnapshot(pool,row.id)).resolved).toContainEqual({ id:'other',outcome:'cancelled' });
  await expect(decidePermission(pool,client,'offline',decision)).rejects.toMatchObject({ status:409 });
});

it('excludes persisted permission waiting from active time without changing original start timestamps', () => {
  const job = { startedAt:new Date(100),metadata:{ permissionWaitMs:200,permissionWaitStartedAt:500 } };
  expect(activeElapsed(job,10_000)).toBe(200);
  expect(activeElapsed({ ...job,metadata:{ permissionWaitMs:9_700,permissionWaitStartedAt:null } },10_100)).toBe(300);
});
