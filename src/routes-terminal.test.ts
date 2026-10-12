import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createAuthHook, hashToken, writeAuthConfig } from './auth.js';
import { createPool, runModuleMigrations, defaultMigrationsDir } from './db.js';
import type { JobEngine } from './engine.js';
import { registerRoutes } from './routes.js';
import { TerminalCapError, TerminalTmuxError, type TerminalRegistry } from './terminals.js';
import { testConfig } from './testkit.js';

/**
 * /api/v1/terminals* contract tests against a REAL Fastify app (inject — no
 * sockets) and a REAL Postgres for the auth hook. The terminal registry is
 * a behavior-driven fake: no tmux, no ptys. Boot mirrors routes.test.ts.
 */

const HUB_TOKEN = 'test-terminal-token-32-bytes-xxx!';

let pool: Pool;
let app: FastifyInstance;
let root: string;

// Mutable fake-registry behavior (reset per test in beforeEach).
let availableResult = true;
let availableCalls = 0;
let createThrows: Error | null = null;
let createCalls: Array<{ cols: number; rows: number; name?: string; idempotencyKey?: string }>;
let readCalls: Array<{ id: string; sinceSeq: number; waitMs: number; attach: boolean }>;
let writtenInputs: Array<{ id: string; data: string }>;

function fakeRegistry(): TerminalRegistry {
  return {
    available: async () => {
      availableCalls += 1;
      return availableResult;
    },
    create: async (input: { cols: number; rows: number; name?: string; idempotencyKey?: string }) => {
      if (createThrows) throw createThrows;
      createCalls.push(input);
      return { id: 'nxt-abc123', name: input.name ?? 'nxt-abc123', createdAt: '2026-10-10T00:00:00.000Z' };
    },
    list: async () => ({
      sessions: [{
        id: 'nxt-abc123', name: 'dev', cols: 80, rows: 24, status: 'live', clients: 1,
        createdAt: '2026-10-10T00:00:00.000Z', lastActiveAt: '2026-10-10T00:00:01.000Z',
      }],
    }),
    input: (id: string, data: string) => {
      if (id !== 'nxt-abc123') return 'not_found';
      writtenInputs.push({ id, data });
      return 'ok';
    },
    resize: (id: string) => (id === 'nxt-abc123' ? 'ok' : 'not_found'),
    detach: (id: string) => (id === 'nxt-abc123' ? 'ok' : 'not_found'),
    read: async (id: string, sinceSeq: number, holdMs: number, attach: boolean) => {
      readCalls.push({ id, sinceSeq, waitMs: holdMs, attach });
      if (id !== 'nxt-abc123') return null;
      return {
        seq: 9,
        chunks: [{ seq: 9, data: '$ ' }],
        snapshot: attach ? 'SNAP' : null,
        status: 'live' as const,
        eof: false,
      };
    },
    kill: async () => 'ok' as const,
    stopAll: async () => undefined,
  } as unknown as TerminalRegistry;
}

beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL!);
  await pool.query('DROP SCHEMA IF EXISTS executor CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS platform CASCADE');
  await runModuleMigrations(pool, 'executor', 'executor', defaultMigrationsDir());
  await writeAuthConfig(pool, {
    tokenHash: hashToken(HUB_TOKEN), hubUrl: 'http://hub.local', name: 'hub', pairedAt: new Date().toISOString(),
  });
  root = mkdtempSync(join(tmpdir(), 'nexus-exec-term-routes-'));
  const config = testConfig(join(root, 'workspaces'));
  app = Fastify({ logger: false });
  app.addHook('preHandler', createAuthHook(pool));
  registerRoutes(app, {
    pool, config, engine: null as unknown as JobEngine, client: null, startedAt: Date.now(),
    registry: fakeRegistry(),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  availableResult = true;
  availableCalls = 0;
  createThrows = null;
  createCalls = [];
  readCalls = [];
  writtenInputs = [];
});

function auth(token = HUB_TOKEN): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

describe('terminal routes', () => {
  it('requires the hub bearer token (no auth skip-list)', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/v1/terminals', payload: { cols: 80, rows: 24 } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/terminals' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/terminals/nxt-abc123/output' })).statusCode).toBe(401);
  });

  it('creates, lists, inputs, resizes, detaches, kills', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/terminals', headers: auth(), payload: { cols: 80, rows: 24, name: 'dev' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'nxt-abc123', name: 'dev' });
    expect(typeof created.json().createdAt).toBe('string');
    expect(createCalls).toEqual([{ cols: 80, rows: 24, name: 'dev' }]);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/terminals', headers: auth() });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().sessions).toHaveLength(1);
    expect(listed.json().sessions[0]).toMatchObject({ id: 'nxt-abc123', status: 'live', cols: 80, rows: 24, clients: 1 });

    const input = await app.inject({
      method: 'POST', url: '/api/v1/terminals/nxt-abc123/input', headers: auth(),
      payload: { dataBase64: Buffer.from('ls\n').toString('base64') },
    });
    expect(input.statusCode).toBe(200);
    expect(input.json()).toEqual({ ok: true });
    expect(writtenInputs).toEqual([{ id: 'nxt-abc123', data: 'ls\n' }]);

    const missing = await app.inject({
      method: 'POST', url: '/api/v1/terminals/nxt-nope/input', headers: auth(), payload: { dataBase64: 'eA==' },
    });
    expect(missing.statusCode).toBe(404);

    const resize = await app.inject({
      method: 'POST', url: '/api/v1/terminals/nxt-abc123/resize', headers: auth(), payload: { cols: 132, rows: 43 },
    });
    expect(resize.statusCode).toBe(200);
    expect(resize.json()).toEqual({ ok: true });

    const detach = await app.inject({ method: 'POST', url: '/api/v1/terminals/nxt-abc123/detach', headers: auth(), payload: {} });
    expect(detach.statusCode).toBe(200);
    expect(detach.json()).toEqual({ ok: true });

    // Kill is idempotent: both calls answer 200.
    const first = await app.inject({ method: 'POST', url: '/api/v1/terminals/nxt-abc123/kill', headers: auth(), payload: {} });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });
    const second = await app.inject({ method: 'POST', url: '/api/v1/terminals/nxt-abc123/kill', headers: auth(), payload: {} });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true });
  });

  it('reads output with long-poll params, base64 chunks, and a waitMs clamp', async () => {
    const out = await app.inject({
      method: 'GET', url: '/api/v1/terminals/nxt-abc123/output?sinceSeq=8&waitMs=2000&attach=1', headers: auth(),
    });
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({
      seq: 9,
      chunks: [{ seq: 9, dataBase64: Buffer.from('$ ').toString('base64') }],
      snapshot: 'SNAP',
      status: 'live',
      eof: false,
    });
    expect(readCalls).toEqual([{ id: 'nxt-abc123', sinceSeq: 8, waitMs: 2_000, attach: true }]);

    const clamped = await app.inject({
      method: 'GET', url: '/api/v1/terminals/nxt-abc123/output?sinceSeq=0&waitMs=999999', headers: auth(),
    });
    expect(clamped.statusCode).toBe(200);
    expect(readCalls[1]).toMatchObject({ id: 'nxt-abc123', sinceSeq: 0, waitMs: 15_000, attach: false });

    const unknown = await app.inject({ method: 'GET', url: '/api/v1/terminals/nxt-nope/output', headers: auth() });
    expect(unknown.statusCode).toBe(404);
  });

  it('gates list/create/input/etc. when tmux is unavailable — but never gates output', async () => {
    availableResult = false;

    const created = await app.inject({
      method: 'POST', url: '/api/v1/terminals', headers: auth(), payload: { cols: 80, rows: 24 },
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().error).toMatch(/terminals_unavailable/);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/terminals', headers: auth() });
    expect(listed.statusCode).toBe(400);
    expect(listed.json().error).toMatch(/terminals_unavailable/);

    const input = await app.inject({
      method: 'POST', url: '/api/v1/terminals/nxt-abc123/input', headers: auth(), payload: { dataBase64: 'eA==' },
    });
    expect(input.statusCode).toBe(400);
    expect(input.json().error).toMatch(/terminals_unavailable/);

    const callsBeforeOutput = availableCalls;
    const out = await app.inject({ method: 'GET', url: '/api/v1/terminals/nxt-abc123/output?sinceSeq=0', headers: auth() });
    expect(out.statusCode).toBe(200);
    expect(availableCalls).toBe(callsBeforeOutput); // no available() call on the output path
  });

  it('pins the exact terminals_unavailable wire prefix when tmux is missing', async () => {
    availableResult = false;
    const created = await app.inject({
      method: 'POST', url: '/api/v1/terminals', headers: auth(), payload: { cols: 80, rows: 24 },
    });
    expect(created.statusCode).toBe(400);
    // The console keys its disabled-state copy on this prefix — do not reword.
    expect(created.json().error).toMatch(/^terminals_unavailable: tmux/);
  });

  it('rejects bad payloads with 400', async () => {
    const missing = await app.inject({
      method: 'POST', url: '/api/v1/terminals/nxt-abc123/input', headers: auth(), payload: {},
    });
    expect(missing.statusCode).toBe(400);

    const badBase64 = await app.inject({
      method: 'POST', url: '/api/v1/terminals/nxt-abc123/input', headers: auth(), payload: { dataBase64: '!!!' },
    });
    expect(badBase64.statusCode).toBe(400);

    const nonInteger = await app.inject({
      method: 'POST', url: '/api/v1/terminals/nxt-abc123/resize', headers: auth(), payload: { cols: 80.5, rows: 24 },
    });
    expect(nonInteger.statusCode).toBe(400);

    const negative = await app.inject({
      method: 'GET', url: '/api/v1/terminals/nxt-abc123/output?sinceSeq=-1', headers: auth(),
    });
    expect(negative.statusCode).toBe(400);

    const longName = await app.inject({
      method: 'POST', url: '/api/v1/terminals', headers: auth(), payload: { cols: 80, rows: 24, name: 'n'.repeat(61) },
    });
    expect(longName.statusCode).toBe(400);

    const badKey = await app.inject({
      method: 'POST', url: '/api/v1/terminals', headers: auth(), payload: { cols: 80, rows: 24, idempotencyKey: 'Bad Key!' },
    });
    expect(badKey.statusCode).toBe(400);
  });

  it('maps registry errors: cap → 429, tmux failure → 502', async () => {
    createThrows = new TerminalCapError(8);
    const capped = await app.inject({
      method: 'POST', url: '/api/v1/terminals', headers: auth(), payload: { cols: 80, rows: 24 },
    });
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error).toMatch(/limit reached/i);

    createThrows = new TerminalTmuxError('tmux new-session failed: no server');
    const broken = await app.inject({
      method: 'POST', url: '/api/v1/terminals', headers: auth(), payload: { cols: 80, rows: 24 },
    });
    expect(broken.statusCode).toBe(502);
    expect(broken.json().error).toContain('no server');
  });
});
