import { afterEach, describe, expect, it } from 'vitest';
import { unlinkSync, existsSync, readdirSync } from 'node:fs';
import { enrollGateway } from './gateway.js';
import type { ExecutorConfig } from './config.js';

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
  // Remove any identity files the test created so a later run never
  // short-circuits on a stale identity.
  const pid = String(process.pid);
  for (const name of readdirSync('/tmp')) {
    if (name.startsWith(`gw-enroll-test-${pid}-`) && name.endsWith('.json')) {
      try { unlinkSync(`/tmp/${name}`); } catch { /* already gone */ }
    }
  }
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