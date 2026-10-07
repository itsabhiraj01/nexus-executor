import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { ExecutorConfig } from './config.js';
import { createOpenCodeClient, type ModelRef, type OpenCodeClient, type OpenCodeMessage } from './opencode.js';
import { execGit } from './workspace.js';

/**
 * Test-only helpers shared by the worker/engine suites. NOT part of the
 * production build (tsconfig excludes it); vitest resolves it regardless.
 */

export const TEST_AUTHOR: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};

/** A real git repo (default branch `main`, one commit) under `dir`. */
export async function makeRepo(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const init = await execGit(['init', '-b', 'main'], { cwd: dir });
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr}`);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  await execGit(['add', '-A', '--', '.'], { cwd: dir });
  const commit = await execGit(['commit', '-m', 'initial'], { cwd: dir, env: TEST_AUTHOR });
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.stderr}`);
  return dir;
}

/** A config pointed at the guarded test database with all guards off —
 *  stalls/timeouts are enabled per test via overrides. */
export function testConfig(workspaceRoot: string, overrides: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    databaseUrl: process.env.DATABASE_URL!,
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',
    executorName: 'test-executor',
    publicUrl: null,
    hubUrl: null,
    pairCode: null,
    opencode: { baseUrl: 'http://stub', token: 'stub', agent: 'build' },
    workspaceRoot,
    baseRef: null,
    deployCommand: null,
    maxParallelJobs: 1,
    pollIntervalMs: 60_000,
    toolStallMs: 0,
    silenceStallMs: 0,
    toolProgressMs: 0,
    jobTimeoutMs: 0,
    // Retries off by default so existing failure assertions stay one-shot;
    // retry suites override.
    retryMaxAttempts: 1,
    retryDelayMinutes: 0,
    ...overrides,
  };
}

export interface StubState {
  sessions: Array<{ id: string; title: string; directory?: string; model?: ModelRef | null }>;
  prompts: Array<{ sessionId: string; text: string }>;
  interrupts: string[];
  /** Session model switches (the usage-limit fallback path). */
  modelSwitches: Array<{ sessionId: string; model: ModelRef }>;
  /** The full message list per session — tests mutate it between polls. */
  messages: Record<string, OpenCodeMessage[]>;
  models: Array<{ id: string; name: string; providerID?: string }>;
}

/**
 * An OpenCode client answered by a scripted in-memory stub (the real
 * `createOpenCodeClient` with an injectable fetch), the same approach the
 * hub's builder e2e uses. Foreign (unknown) session ids get a 404 — the
 * worker must skip those silently.
 */
export function makeStubClient(): { client: OpenCodeClient; state: StubState } {
  const state: StubState = {
    sessions: [], prompts: [], interrupts: [], modelSwitches: [], messages: {},
    models: [{ id: 'open-large', name: 'Open Large', providerID: 'litellm' }],
  };
  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify({ data }), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.endsWith('/api/session')) {
      const body = JSON.parse(String(init!.body)) as {
        title?: string; location?: { directory?: string }; model?: { providerID: string; id: string };
      };
      const id = `ses_stub_${state.sessions.length + 1}`;
      state.sessions.push({
        id, title: body.title ?? '', directory: body.location?.directory,
        model: body.model ? { providerID: body.model.providerID, modelID: body.model.id } : null,
      });
      state.messages[id] = [];
      return json({ id, model: body.model ?? null });
    }
    const promptMatch = /\/api\/session\/([^/]+)\/prompt$/.exec(url);
    if (method === 'POST' && promptMatch) {
      if (!state.messages[promptMatch[1]!]) return json({ error: 'unknown session' }, 404);
      const body = JSON.parse(String(init!.body)) as { text: string };
      state.prompts.push({ sessionId: promptMatch[1]!, text: body.text });
      return json({ id: `msg_p${state.prompts.length}` });
    }
    const modelMatch = /\/api\/session\/([^/]+)\/model$/.exec(url);
    if (method === 'POST' && modelMatch) {
      const session = state.sessions.find((entry) => entry.id === modelMatch[1]);
      if (!session) return json({ error: 'unknown session' }, 404);
      const body = JSON.parse(String(init!.body)) as { model: { providerID: string; id: string } };
      const ref = { providerID: body.model.providerID, modelID: body.model.id };
      session.model = ref;
      state.modelSwitches.push({ sessionId: session.id, model: ref });
      return new Response(null, { status: 204 });
    }
    const interruptMatch = /\/api\/session\/([^/]+)\/interrupt$/.exec(url);
    if (method === 'POST' && interruptMatch) {
      if (!state.messages[interruptMatch[1]!]) return json({ error: 'unknown session' }, 404);
      state.interrupts.push(interruptMatch[1]!);
      return new Response(null, { status: 204 });
    }
    const messageMatch = /\/api\/session\/([^/]+)\/message$/.exec(url);
    if (method === 'GET' && messageMatch) {
      if (!state.messages[messageMatch[1]!]) return json({ error: 'unknown session' }, 404);
      return json(state.messages[messageMatch[1]!]);
    }
    if (method === 'GET' && /\/api\/model/.test(url)) {
      return json(state.models);
    }
    return json({ error: 'not found' }, 404);
  };
  return {
    client: createOpenCodeClient({ baseUrl: 'http://stub', token: 'stub', fetchImpl: fetchImpl as typeof fetch }),
    state,
  };
}

export async function eventTypes(pool: Pool, jobId: string): Promise<string[]> {
  const { rows } = await pool.query<{ event_type: string }>(
    `SELECT event_type FROM executor.job_events WHERE job_id = $1 ORDER BY sequence_number ASC`, [jobId]);
  return rows.map((row) => row.event_type);
}

export async function countEvents(pool: Pool, jobId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM executor.job_events WHERE job_id = $1`, [jobId]);
  return rows[0]?.n ?? 0;
}

/** Wipe job + event rows (auth/config untouched). */
export async function wipeJobs(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM executor.job_events');
  await pool.query('DELETE FROM executor.jobs');
}
