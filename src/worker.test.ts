import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ExecutorConfig } from './config.js';
import { createPool, runModuleMigrations, defaultMigrationsDir } from './db.js';
import { EVENT, JobEngine, getJobByHubId, type JobSpecInput } from './engine.js';
import type { OpenCodeMessage } from './opencode.js';
import { makeRepo, makeStubClient, testConfig, wipeJobs, eventTypes } from './testkit.js';
import { execGit } from './workspace.js';
import { startWorker } from './worker.js';

let pool: Pool;
let root: string;
let repoRoot: string;
let config: ExecutorConfig;

beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL!);
  await pool.query('DROP SCHEMA IF EXISTS executor CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS platform CASCADE');
  await runModuleMigrations(pool, 'executor', 'executor', defaultMigrationsDir());
  root = mkdtempSync(join(tmpdir(), 'nexus-exec-worker-'));
  repoRoot = await makeRepo(join(root, 'repo'));
  config = testConfig(join(root, 'workspaces'));
});

afterAll(async () => {
  await pool.end();
  if (existsSync(repoRoot)) await execGit(['worktree', 'prune'], { cwd: repoRoot });
  rmSync(root, { recursive: true, force: true });
});

function jobSpec(jobId: string, overrides: Partial<JobSpecInput> = {}): JobSpecInput {
  return {
    jobId, title: jobId, prompt: 'Work.',
    verificationCommand: '', project: { name: 'repo', localPath: repoRoot },
    models: [], attachments: [],
    ...overrides,
  };
}

function stubEngine(overrides: Partial<ExecutorConfig> = {}) {
  const { client, state } = makeStubClient();
  const errors: unknown[] = [];
  const engine = new JobEngine({
    pool,
    config: { ...config, ...overrides },
    client,
    git: execGit,
    onError: (error) => errors.push(error),
  });
  return { engine, state, errors };
}

describe('admission', () => {
  it('runs one job per slot and chains the queued job after the slot frees', async () => {
    await wipeJobs(pool);
    const { engine, state, errors } = stubEngine();
    const first = await engine.createJob(jobSpec('job-cap-1'));
    expect(first.created).toBe(true);
    const second = await engine.createJob(jobSpec('job-cap-2'));
    expect(second.created).toBe(true);

    expect((await getJobByHubId(pool, 'job-cap-1'))!.status).toBe('running');
    expect((await getJobByHubId(pool, 'job-cap-2'))!.status).toBe('queued');
    expect(state.sessions).toHaveLength(1);

    await engine.cancel('job-cap-1');
    await engine.admitQueued();
    expect((await getJobByHubId(pool, 'job-cap-2'))!.status).toBe('running');
    expect(state.sessions).toHaveLength(2);
    expect(errors).toEqual([]);
    await engine.cancel('job-cap-2');
  });

  it('resumes a created row that already has a session (crash between launch and running)', async () => {
    await wipeJobs(pool);
    const { engine } = stubEngine();
    await engine.createJob(jobSpec('job-resume'));
    // Simulate the crash: flip back to created as if the running update never landed.
    await pool.query(`UPDATE executor.jobs SET status = 'created' WHERE hub_job_id = 'job-resume'`);
    await engine.admitQueued();
    const row = (await getJobByHubId(pool, 'job-resume'))!;
    expect(row.status).toBe('running');
    await engine.cancel('job-resume');
  });
});

describe('stall + timeout guards', () => {
  it('fails a job whose tool ran past the tool-stall threshold, interrupting first', async () => {
    await wipeJobs(pool);
    const { engine, state } = stubEngine({ toolStallMs: 1_000, toolProgressMs: 0, silenceStallMs: 0 });
    const job = (await engine.createJob(jobSpec('job-stall-tool'))).job;
    const row = (await getJobByHubId(pool, 'job-stall-tool'))!;
    const startedAgo = Date.now() - 10_000;
    const messages: OpenCodeMessage[] = [{
      id: 'm1', type: 'assistant', finish: null, time: { created: startedAgo },
      content: [{ type: 'tool', tool: 'shell', state: { status: 'running', input: { command: 'sleep 999' }, output: 'partial' } , time: { ran: startedAgo } }],
    }];
    state.messages[job.opencodeSessionId!] = messages;

    await engine.pollJob(row);
    const after = (await getJobByHubId(pool, 'job-stall-tool'))!;
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('agent_stalled');
    expect(after.failureReason).toContain('Agent stalled');
    expect(after.failureReason).toContain('no progress');
    expect(after.failureReason).toContain("'sleep 999'");
    expect(state.interrupts).toContain(row.opencodeSessionId);
    const types = await eventTypes(pool, row.id);
    expect(types).toContain(EVENT.EXECUTION_FAILED);
  });

  it('fails a wedged-from-birth tool on first sight via the no-progress check', async () => {
    await wipeJobs(pool);
    const { engine, state } = stubEngine({ toolStallMs: 0, silenceStallMs: 0, toolProgressMs: 1_000 });
    const job = (await engine.createJob(jobSpec('job-stall-wedge'))).job;
    const row = (await getJobByHubId(pool, 'job-stall-wedge'))!;
    const startedAgo = Date.now() - 10_000;
    state.messages[job.opencodeSessionId!] = [{
      id: 'm1', type: 'assistant', finish: null, time: { created: startedAgo },
      content: [{ type: 'tool', tool: 'read', state: { status: 'running' }, time: { ran: startedAgo } }],
    }];
    await engine.pollJob(row);
    const after = (await getJobByHubId(pool, 'job-stall-wedge'))!;
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('agent_stalled');
    expect(after.failureReason).toContain('zero output');
    expect(after.metadata.toolFingerprints).toBeTruthy();
  });

  it('keeps alive a streaming tool whose fingerprint keeps changing', async () => {
    await wipeJobs(pool);
    const { engine, state } = stubEngine({ toolStallMs: 0, silenceStallMs: 0, toolProgressMs: 100 });
    const job = (await engine.createJob(jobSpec('job-progress'))).job;
    const row = (await getJobByHubId(pool, 'job-progress'))!;
    const startedAgo = Date.now() - 10_000;
    for (const chunk of ['a', 'ab', 'abc']) {
      state.messages[job.opencodeSessionId!] = [{
        id: 'm1', type: 'assistant', finish: null, time: { created: startedAgo },
        content: [{ type: 'tool', tool: 'shell', state: { status: 'running', output: chunk }, time: { ran: startedAgo } }],
      }];
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
      await engine.pollJob((await getJobByHubId(pool, 'job-progress'))!);
    }
    const after = (await getJobByHubId(pool, 'job-progress'))!;
    expect(after.status).toBe('running');
    await engine.cancel('job-progress');
  });

  it('fails a silent in-flight turn after the silence threshold', async () => {
    await wipeJobs(pool);
    const { engine, state } = stubEngine({ toolStallMs: 0, silenceStallMs: 1_000, toolProgressMs: 0 });
    const job = (await engine.createJob(jobSpec('job-stall-silent'))).job;
    const row = (await getJobByHubId(pool, 'job-stall-silent'))!;
    state.messages[job.opencodeSessionId!] = [{
      id: 'm1', type: 'assistant', finish: null,
      content: [{ type: 'text', text: 'working on it…' }],
      time: { created: Date.now() - 10_000 },
    }];
    await engine.pollJob(row);
    const after = (await getJobByHubId(pool, 'job-stall-silent'))!;
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('agent_stalled');
    expect(after.failureReason).toContain('no session activity');
  });

  it('times out a started running job, and never one parked on the user', async () => {
    await wipeJobs(pool);
    const { engine, state } = stubEngine({ jobTimeoutMs: 60_000, maxParallelJobs: 2 });
    const running = (await engine.createJob(jobSpec('job-timeout'))).job;
    const parked = (await engine.createJob(jobSpec('job-timeout-parked'))).job;
    assertRunning('job-timeout');
    await pool.query(`UPDATE executor.jobs SET status = 'waiting_for_user' WHERE hub_job_id = 'job-timeout-parked'`);
    await pool.query(`UPDATE executor.jobs SET started_at = NOW() - interval '2 hours' WHERE hub_job_id IN ('job-timeout', 'job-timeout-parked')`);

    await engine.pollJob((await getJobByHubId(pool, 'job-timeout'))!);
    const timedOut = (await getJobByHubId(pool, 'job-timeout'))!;
    expect(timedOut.status).toBe('failed');
    expect(timedOut.errorCode).toBe('execution_timeout');
    expect(timedOut.failureReason).toContain('timed out');
    expect(state.interrupts).toContain(running.opencodeSessionId);

    // The parked job is exempt: polled, unchanged.
    await engine.pollJob((await getJobByHubId(pool, 'job-timeout-parked'))!);
    expect((await getJobByHubId(pool, 'job-timeout-parked'))!.status).toBe('waiting_for_user');
  });

  it('A session the service 404s is skipped without an error', async () => {
    await wipeJobs(pool);
    const { engine, state, errors } = stubEngine();
    const job = (await engine.createJob(jobSpec('job-404'))).job;
    // Wipe the stub's knowledge of the session so the poll 404s.
    delete state.messages[job.opencodeSessionId!];
    await engine.pollJob((await getJobByHubId(pool, 'job-404'))!);
    expect(errors).toEqual([]);
    expect((await getJobByHubId(pool, 'job-404'))!.status).toBe('running');
    await engine.cancel('job-404');
  });
});

describe('the worker loop', () => {
  it('runs an immediate tick, keeps one tick in flight, and stops cleanly', async () => {
    await wipeJobs(pool);
    const { engine, errors } = stubEngine({ pollIntervalMs: 50 });
    await engine.createJob(jobSpec('job-worker-1'));
    const stop = startWorker(engine, { onError: (error) => errors.push(error) });
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    await stop();
    expect(errors).toEqual([]);
    expect((await getJobByHubId(pool, 'job-worker-1'))!.status).toBe('running');
    await engine.cancel('job-worker-1');
  });
});

async function assertRunning(hubJobId: string): Promise<void> {
  expect((await getJobByHubId(pool, hubJobId))!.status).toBe('running');
}
