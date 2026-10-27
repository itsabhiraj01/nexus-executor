import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { unlinkSync, existsSync, readdirSync } from 'node:fs';
import { enrollGateway, runGatewayLoop } from './gateway.js';
import type { ExecutorConfig } from './config.js';
import type { RouteDeps } from './ops.js';
import * as operations from './ops.js';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));

let n = 0;
function nextConfig(): ExecutorConfig & { gatewayIdentityPath: string } {
  n += 1;
  const path = `/tmp/gw-enroll-test-${process.pid}-${n}.json`;
  return {
    databaseUrl: 'postgres://x', port: 4099, host: '0.0.0.0', logLevel: 'info',
    executorName: 'office-pc', publicUrl: null, hubUrl: null, pairCode: 'ABCDEFGH',
    opencode: { baseUrl: null, token: null, agent: 'build' },
    workspaceRoot: '/tmp/ws', baseRef: null, deployCommand: null, maxParallelJobs: 1,
    pollIntervalMs: 2000, toolStallMs: 0, silenceStallMs: 0, toolProgressMs: 0, jobTimeoutMs: 0,
    retryMaxAttempts: 3, retryDelayMinutes: 2, transport: 'gateway',
    gatewayUrl: 'https://gw.example.com', gatewayIdentityPath: path,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  // Remove any identity files the test created so a later run never
  // short-circuits on a stale identity.
  const pid = String(process.pid);
  for (const name of readdirSync('/tmp')) {
    if (name.startsWith(`gw-enroll-test-${pid}-`) && name.endsWith('.json')) {
      try { unlinkSync(`/tmp/${name}`); } catch { /* already gone */ }
    }
  }
});

it.each([500, 30_000])('logs close details and backs off based on session duration (%i ms)', async (duration) => {
  const config = nextConfig();
  await enrollGateway(config, {
    fetchImpl: (async () => new Response(JSON.stringify({ credential: 'test-credential', executorId: 'id-1' }))) as typeof fetch,
  });
  let now = 1_000;
  let connections = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  class FakeSocket extends EventEmitter {
    constructor() {
      super();
      connections++;
      queueMicrotask(() => {
        this.emit('open');
        now += duration;
        this.emit('error', new Error('gateway rejected connection'));
        this.emit('close', 1008, Buffer.from('authentication_failed'));
      });
    }
  }
  const logger = { info: vi.fn(), warn: vi.fn() };
  await runGatewayLoop({} as RouteDeps, config, {
    logger,
    webSocketImpl: FakeSocket as unknown as typeof WebSocket,
    isStopped: () => connections >= 4,
  });
  expect(logger.warn.mock.calls.map(([details]) => details.attempt)).toEqual(
    duration < 30_000 ? [1, 2, 3] : [1, 1, 1],
  );
  expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
    closeCode: 1008, closeReason: 'authentication_failed',
    sessionDurationMs: duration, error: 'gateway rejected connection',
  });
});

it('sends EXECUTOR_NAME in the enrollment body', async () => {
  const config = nextConfig();
  let captured: Record<string, unknown> = {};
  const fakeFetch = (async (_url: string, init: { body?: unknown } | RequestInit) => {
    captured = JSON.parse(String((init as RequestInit).body));
    return new Response(JSON.stringify({ credential: 'test-credential-1234567890abcdef', executorId: 'id-1' }));
  }) as typeof fetch;
  await enrollGateway(config, { fetchImpl: fakeFetch });
  expect(captured.name).toBe('office-pc');
  if (existsSync(config.gatewayIdentityPath)) unlinkSync(config.gatewayIdentityPath);
});

it('coalesces a mutation across socket loss and replays its completed reply on another connection', async () => {
  const config = nextConfig();
  await enrollGateway(config, { fetchImpl: (async () => new Response(JSON.stringify({ credential: 'test', executorId: 'id' }))) as typeof fetch });
  let complete!: (value: { ok: true }) => void;
  const mutate = vi.spyOn(operations, 'handleGatewayOperation').mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  let connections = 0;
  let stopped = false;
  const replies: unknown[] = [];
  const request = Buffer.from(JSON.stringify({ version: operations.GATEWAY_PROTOCOL_VERSION, type: 'request', id: 'stable-mutation', operation: 'job.message', payload: { jobId: 'job', text: 'continue' } }));
  class Socket extends EventEmitter {
    readonly OPEN = 1;
    readyState = 1;
    constructor() {
      super();
      const connection = ++connections;
      queueMicrotask(() => {
        this.emit('open');
        this.emit('message', request);
        if (connection === 1) {
          this.readyState = 3;
          this.emit('close', 1006, Buffer.from('lost'));
        } else if (connection === 2) queueMicrotask(() => complete({ ok: true }));
      });
    }
    send(response: string) {
      if (this.readyState !== this.OPEN) throw new Error('closed socket');
      replies.push(JSON.parse(response));
      if (connections === 3) stopped = true;
      this.readyState = 3;
      this.emit('close', 1000, Buffer.from('reconnect'));
    }
  }
  await runGatewayLoop({} as RouteDeps, config, { logger: { info: vi.fn(), warn: vi.fn() }, webSocketImpl: Socket as unknown as typeof WebSocket, isStopped: () => stopped });
  expect(connections).toBe(3);
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(replies).toHaveLength(2);
  expect(replies[0]).toEqual(replies[1]);
});
