import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createAuthHook, hashToken, writeAuthConfig } from './auth.js';
import { createPool, runModuleMigrations, defaultMigrationsDir } from './db.js';
import { JobEngine } from './engine.js';
import { claimPairing, PairingError } from './pairing.js';
import { registerRoutes } from './routes.js';
import { testConfig, wipeJobs } from './testkit.js';

/**
 * Route + auth contract tests against a REAL Fastify app (inject — no
 * sockets) and a REAL Postgres. The OpenCode client is left unconfigured:
 * jobs admit into `queued`, which is exactly the state the queue-only
 * assertions want.
 */

const HUB_TOKEN = 'test-hub-token-32-bytes-for-suite!!';

let pool: Pool;
let app: FastifyInstance;
let engine: JobEngine;
let root: string;

beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL!);
  await pool.query('DROP SCHEMA IF EXISTS executor CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS platform CASCADE');
  await runModuleMigrations(pool, 'executor', 'executor', defaultMigrationsDir());
  root = mkdtempSync(join(tmpdir(), 'nexus-exec-routes-'));
  const config = testConfig(join(root, 'workspaces'));
  engine = new JobEngine({ pool, config, client: null });
  app = Fastify({ logger: false });
  app.addHook('preHandler', createAuthHook(pool));
  registerRoutes(app, { pool, config, engine, client: null, startedAt: Date.now() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await wipeJobs(pool);
});

function auth(token = HUB_TOKEN): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function validJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: `job-${Math.random().toString(36).slice(2, 10)}`,
    title: 'Contract job',
    prompt: 'Do the contract thing.',
    project: { name: 'repo', localPath: '/srv/repo' },
    ...overrides,
  };
}

describe('unpaired executor', () => {
  it('answers 503 on /api/v1/* and 200 on /health', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/v1/status' });
    expect(status.statusCode).toBe(503);
    expect(status.json()).toEqual({ error: 'This executor is not paired yet.' });

    const create = await app.inject({ method: 'POST', url: '/api/v1/jobs', payload: validJob() });
    expect(create.statusCode).toBe(503);

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, db: 'up', paired: false });
  });
});

describe('pairing claim', () => {
  it('stores only the token hash and is a no-op once paired', async () => {
    const config = {
      ...testConfig(join(root, 'w')),
      hubUrl: 'http://hub.local',
      pairCode: 'CODE-123',
      publicUrl: 'http://exec.local:4099',
      executorName: 'office-box',
    };
    let claimed: unknown;
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      claimed = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ executorId: 'exec-1', token: 'raw-hub-token' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const outcome = await claimPairing(config, pool, { fetchImpl });
    expect(outcome).toMatchObject({ alreadyPaired: false, id: 'exec-1', name: 'office-box', hubUrl: 'http://hub.local' });
    expect(claimed).toMatchObject({
      code: 'CODE-123', name: 'office-box', url: 'http://exec.local:4099',
      capabilities: { jobRetries: true, modelFallback: true },
    });

    const { rows } = await pool.query<{ value: { tokenHash: string; hubUrl: string } }>(
      `SELECT value FROM executor.config WHERE key = 'auth'`);
    expect(rows[0]!.value.tokenHash).toBe(hashToken('raw-hub-token'));
    expect(JSON.stringify(rows[0]!.value)).not.toContain('raw-hub-token');

    const again = await claimPairing(config, pool, { fetchImpl });
    expect(again.alreadyPaired).toBe(true);

    await pool.query(`DELETE FROM executor.config WHERE key = 'auth'`);
  });

  it('fails loud on a hub refusal', async () => {
    const config = {
      ...testConfig(join(root, 'w2')),
      hubUrl: 'http://hub.local', pairCode: 'CODE-BAD', publicUrl: 'http://exec.local:4099',
    };
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'code already claimed' }), { status: 409 })) as typeof fetch;
    await expect(claimPairing(config, pool, { fetchImpl })).rejects.toMatchObject({
      message: expect.stringContaining('409') as string,
    });
    await expect(claimPairing(config, pool, { fetchImpl })).rejects.toBeInstanceOf(PairingError);
  });
});

describe('paired executor', () => {
  beforeAll(async () => {
    await writeAuthConfig(pool, {
      tokenHash: hashToken(HUB_TOKEN), hubUrl: 'http://hub.local', name: 'hub', pairedAt: new Date().toISOString(),
    });
  });

  it('rejects missing and wrong tokens, then serves status', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/status' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/status', headers: auth('wrong') })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/api/v1/status', headers: auth() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      ok: true, name: 'test-executor', version: '0.2.0', paired: true,
      opencode: { configured: false, baseUrl: 'http://stub' },
      jobs: { active: 0, queued: 0, total: 0 },
      // The hub gates its own auto-retry on jobRetries (an executor that
      // retries in-job must never also be retried by the hub).
      capabilities: { jobRetries: true, modelFallback: true },
    });
    expect(typeof ok.json().uptimeSeconds).toBe('number');

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toMatchObject({ ok: true, db: 'up', paired: true });
  });

  it('PUT /config upserts the hub-pushed values', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/v1/config', payload: { systemPrompt: 'Be careful.' } })).statusCode).toBe(401);
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/config', headers: auth(),
      payload: { systemPrompt: 'Be careful.', defaults: { maxParallel: 2 }, models: ['litellm/open-large'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const { rows } = await pool.query<{ key: string; value: unknown }>(`SELECT key, value FROM executor.config WHERE key IN ('systemPrompt','defaults','models') ORDER BY key`);
    expect(rows.map((row) => [row.key, row.value])).toEqual([
      ['defaults', { maxParallel: 2 }],
      ['models', ['litellm/open-large']],
      ['systemPrompt', 'Be careful.'],
    ]);
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/config', headers: auth(), payload: { models: ['no-slash'] } });
    expect(bad.statusCode).toBe(400);
    await pool.query(`DELETE FROM executor.config WHERE key IN ('systemPrompt','defaults','models')`);
  });

  it('validates POST /jobs', async () => {
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/jobs', headers: auth(), payload: payload as Record<string, unknown> });
    expect((await post({})).statusCode).toBe(400);
    expect((await post(validJob({ prompt: '' }))).statusCode).toBe(400);
    expect((await post(validJob({ prompt: 'x'.repeat(200_001) }))).statusCode).toBe(400);
    expect((await post(validJob({ project: { name: 'nothing' } }))).statusCode).toBe(400);
    expect((await post(validJob({ models: ['not-a-ref'] }))).statusCode).toBe(400);
    expect((await post(validJob({
      attachments: Array.from({ length: 11 }, (_, index) => ({ name: `f${index}.txt`, mimeType: 'text/plain', dataBase64: 'aGk=' })),
    }))).statusCode).toBe(400);
    const big = Buffer.alloc(13 * 1024 * 1024, 65).toString('base64');
    expect((await post(validJob({
      attachments: [
        { name: 'a.bin', mimeType: 'application/octet-stream', dataBase64: big },
        { name: 'b.bin', mimeType: 'application/octet-stream', dataBase64: big },
      ],
    }))).statusCode).toBe(400);
    expect((await post(validJob({ attachments: [{ name: 'x', mimeType: 'text/plain', dataBase64: '***not base64***' }] }))).statusCode).toBe(400);
    // The retry envelope: both fields bounded, both optional.
    expect((await post(validJob({ retry: 'yes' }))).statusCode).toBe(400);
    expect((await post(validJob({ retry: { maxAttempts: 0 } }))).statusCode).toBe(400);
    expect((await post(validJob({ retry: { maxAttempts: 11 } }))).statusCode).toBe(400);
    expect((await post(validJob({ retry: { delayMinutes: -1 } }))).statusCode).toBe(400);
    expect((await post(validJob({ retry: { delayMinutes: 61 } }))).statusCode).toBe(400);
    const okJob = await post(validJob({ retry: { maxAttempts: 3, delayMinutes: 5 } }));
    expect(okJob.statusCode).toBe(201);
    expect(okJob.json().job).toMatchObject({ maxAttempts: 3, attemptCount: 1 });
  });

  it('creates a job (queued without OpenCode) and is idempotent on jobId', async () => {
    const payload = validJob({ jobId: 'job-routes-1', models: ['litellm/open-large'], verificationCommand: 'npm test' });
    const created = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: auth(), payload });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json().job;
    expect(createdBody).toMatchObject({ hubJobId: 'job-routes-1', status: 'queued', title: 'Contract job' });
    expect(createdBody.id).toBeTruthy();
    expect(createdBody.createdAt).toBeTruthy();

    const again = await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: auth(), payload: { ...payload, prompt: 'different' } });
    expect(again.statusCode).toBe(200);
    expect(again.json().job.id).toBe(createdBody.id);
  });

  it('lists jobs with a status filter and updatedSince', async () => {
    for (const jobId of ['job-list-1', 'job-list-2', 'job-list-3']) {
      await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: auth(), payload: validJob({ jobId }) });
    }
    await engine.cancel('job-list-3');

    const all = await app.inject({ method: 'GET', url: '/api/v1/jobs', headers: auth() });
    expect(all.statusCode).toBe(200);
    expect(all.json().jobs).toHaveLength(3);
    expect(all.json().jobs[0]).toHaveProperty('hubJobId');

    const queued = await app.inject({ method: 'GET', url: '/api/v1/jobs?status=queued', headers: auth() });
    expect(queued.json().jobs.map((job: { hubJobId: string }) => job.hubJobId).sort()).toEqual(['job-list-1', 'job-list-2']);

    const future = await app.inject({ method: 'GET', url: `/api/v1/jobs?updatedSince=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, headers: auth() });
    expect(future.json().jobs).toHaveLength(0);
    const past = await app.inject({ method: 'GET', url: `/api/v1/jobs?updatedSince=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`, headers: auth() });
    expect(past.json().jobs).toHaveLength(3);

    expect((await app.inject({ method: 'GET', url: '/api/v1/jobs?status=bogus', headers: auth() })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/jobs?updatedSince=nonsense', headers: auth() })).statusCode).toBe(400);
  });

  it('shows job detail with the verification block + event count', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: auth(), payload: validJob({ jobId: 'job-detail', verificationCommand: 'make check' }) });
    const detail = await app.inject({ method: 'GET', url: '/api/v1/jobs/job-detail', headers: auth() });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      hubJobId: 'job-detail', status: 'queued',
      branch: '', worktreePath: '', opencodeSessionId: null, model: '',
      verification: { attempts: 0, lastExitCode: null, lastOutputTail: '' },
      eventCount: 1, // the queued EXECUTION_STATUS_CHANGED
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/jobs/nope', headers: auth() })).statusCode).toBe(404);
  });

  it('paginates events ascending with sinceSeq', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: auth(), payload: validJob({ jobId: 'job-events' }) });
    await engine.cancel('job-events');
    const events = await app.inject({ method: 'GET', url: '/api/v1/jobs/job-events/events', headers: auth() });
    expect(events.statusCode).toBe(200);
    const list = events.json().events;
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ seq: 1, source: 'executor', type: 'EXECUTION_STATUS_CHANGED' });
    expect(list[1]).toMatchObject({ seq: 2, type: 'EXECUTION_CANCELLED' });
    expect(list[0].payload).toEqual({});

    const since = await app.inject({ method: 'GET', url: '/api/v1/jobs/job-events/events?sinceSeq=1', headers: auth() });
    expect(since.json().events).toHaveLength(1);
    expect(since.json().events[0].seq).toBe(2);
    expect((await app.inject({ method: 'GET', url: '/api/v1/jobs/nope/events', headers: auth() })).statusCode).toBe(404);
  });

  it('message: 404 unknown, 409 without a session, 409 on a terminal job', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: auth(), payload: validJob({ jobId: 'job-msg' }) });
    expect((await app.inject({ method: 'POST', url: '/api/v1/jobs/nope/message', headers: auth(), payload: { text: 'hi' } })).statusCode).toBe(404);
    const noSession = await app.inject({ method: 'POST', url: '/api/v1/jobs/job-msg/message', headers: auth(), payload: { text: 'hi' } });
    expect(noSession.statusCode).toBe(409);
    expect(noSession.json()).toEqual({ error: 'This job has no active OpenCode session.' });

    await engine.cancel('job-msg');
    expect((await app.inject({ method: 'POST', url: '/api/v1/jobs/job-msg/message', headers: auth(), payload: { text: 'hi' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/v1/jobs/nope/message', headers: auth(), payload: {} })).statusCode).toBe(400);
  });

  it('cancel is idempotent and returns the job', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: auth(), payload: validJob({ jobId: 'job-cancel-http' }) });
    const first = await app.inject({ method: 'POST', url: '/api/v1/jobs/job-cancel-http/cancel', headers: auth() });
    expect(first.statusCode).toBe(200);
    expect(first.json().job.status).toBe('cancelled');
    const second = await app.inject({ method: 'POST', url: '/api/v1/jobs/job-cancel-http/cancel', headers: auth() });
    expect(second.statusCode).toBe(200);
    expect(second.json().job.status).toBe('cancelled');
    expect((await app.inject({ method: 'POST', url: '/api/v1/jobs/nope/cancel', headers: auth() })).statusCode).toBe(404);
  });

  it('verify guardrails: 409 queued/running, 409 without a command, 404 unknown', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: auth(), payload: validJob({ jobId: 'job-verify-1' }) });
    expect((await app.inject({ method: 'POST', url: '/api/v1/jobs/job-verify-1/verify', headers: auth() })).statusCode).toBe(409);
    await engine.cancel('job-verify-1');
    const noCommand = await app.inject({ method: 'POST', url: '/api/v1/jobs/job-verify-1/verify', headers: auth() });
    expect(noCommand.statusCode).toBe(409);
    expect(noCommand.json().error).toContain('verification command');
    expect((await app.inject({ method: 'POST', url: '/api/v1/jobs/nope/verify', headers: auth() })).statusCode).toBe(404);
  });

  it('merge 409s for non-succeeded jobs, log reports gone for a queued job', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/jobs', headers: auth(), payload: validJob({ jobId: 'job-merge-1' }) });
    const merge = await app.inject({ method: 'POST', url: '/api/v1/jobs/job-merge-1/merge', headers: auth() });
    expect(merge.statusCode).toBe(409);
    const log = await app.inject({ method: 'GET', url: '/api/v1/jobs/job-merge-1/log', headers: auth() });
    expect(log.statusCode).toBe(200);
    expect(log.json()).toEqual({ gone: true });
    expect((await app.inject({ method: 'GET', url: '/api/v1/jobs/nope/log', headers: auth() })).statusCode).toBe(404);
  });

  it('models answers 503 without an OpenCode configuration', async () => {
    const models = await app.inject({ method: 'GET', url: '/api/v1/models', headers: auth() });
    expect(models.statusCode).toBe(503);
    expect(models.json()).toEqual({ error: 'OpenCode is not configured' });
  });
});
