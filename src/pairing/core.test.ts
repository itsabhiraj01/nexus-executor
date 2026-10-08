import { describe, expect, it, afterEach, test } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pair, selectTransport } from './core.js';
import { readCliState } from './state.js';

function tmpEnv(): { dir: string; identityPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-executor-core-'));
  const identityPath = join(dir, 'gateway-identity.json');
  process.env.NEXUS_EXECUTOR_STATE = join(dir, 'config', 'state.json');
  process.env.GATEWAY_IDENTITY_PATH = identityPath;
  process.env.DATABASE_URL = 'postgres://nope'; // loadConfig requires it; unused by gateway enroll
  return { dir, identityPath };
}

afterEach(() => {
  const p = process.env.NEXUS_EXECUTOR_STATE;
  if (p) rmSync(p.replace(/\/state\.json$/, ''), { recursive: true, force: true });
  const ident = process.env.GATEWAY_IDENTITY_PATH;
  if (ident) rmSync(ident, { force: true });
  delete process.env.NEXUS_EXECUTOR_STATE;
  delete process.env.GATEWAY_IDENTITY_PATH;
  delete process.env.DATABASE_URL;
});

/** A fetch stub that answers /v1/enroll with a valid-shaped body. */
function visitingGateway(): typeof fetch & { seenEnrollBody?: () => Record<string, unknown> | null } {
  let seen: Record<string, unknown> | null = null;
  const spy = (async (url: unknown, init?: unknown) => {
    seen = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ credential: 'cred-abc', executorId: 'exec_01KXYZ' }));
  }) as typeof fetch & { seenEnrollBody?: () => Record<string, unknown> | null };
  spy.seenEnrollBody = () => seen;
  return spy;
}

describe('pair() — gateway transport (default)', () => {
  it('enrolls via the gateway and writes CLI state', async () => {
    tmpEnv();
    const spy = visitingGateway();
    const result = await pair({
      transport: 'gateway',
      gatewayUrl: 'https://gateway.example.com',
      pairingCode: 'ABC123',
      executorName: 'home-server',
      fetchImpl: spy,
    });
    expect(result.transport).toBe('gateway');
    expect(result.executorId).toBe('exec_01KXYZ');
    expect(spy.seenEnrollBody?.()?.enrollment_token).toBe('ABC123');

    const state = readCliState();
    expect(state?.transport).toBe('gateway');
    expect((state as { gatewayUrl?: string }).gatewayUrl).toBe('https://gateway.example.com');
    expect((state as { name?: string }).name).toBe('home-server');
    expect((state as { identityPath?: string }).identityPath).toBeTruthy();
    expect(existsSync(process.env.GATEWAY_IDENTITY_PATH as string)).toBe(true);
  });

  it('throws a clear error when the gateway is unreachable and leaves state clean', async () => {
    tmpEnv();
    await expect(pair({
      transport: 'gateway',
      gatewayUrl: 'https://gateway.example.com',
      pairingCode: 'ABC123',
      executorName: 'x',
      fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    })).rejects.toThrow(/gateway/i);
    expect(readCliState()).toBeNull();
    expect(existsSync(process.env.GATEWAY_IDENTITY_PATH as string)).toBe(false);
  });
});

describe('selectTransport', () => {
  test('prefers CLI state over env', () => {
    expect(selectTransport('direct', 'gateway')).toBe('gateway');
    expect(selectTransport('gateway', 'direct')).toBe('direct');
    expect(selectTransport('gateway', null)).toBe('gateway');
    expect(selectTransport(undefined, null)).toBe('direct');
  });
});