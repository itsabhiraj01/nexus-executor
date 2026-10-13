import { afterEach, beforeEach, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createPublicKey, generateKeyPairSync, verify as ed25519Verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildConnectHeaders, type GatewayIdentity } from '../gateway.js';
import {
  buildInvalidConnectHeaders,
  classifyRepair,
  probeConnect,
  repairFromCli,
  sameFailureSignature,
  type ProbeOutcome,
  type RepairDeps,
  type RouteOutcome,
} from './repair.js';

/**
 * `nexus-executor repair` — the classification table is the product: the
 * differential between a valid proof and well-shaped garbage localizes a
 * 1011 without server access. Everything here is hermetic (scripted
 * sockets, injected fetch/exec/db) — no network, no live database.
 */

class ScriptedSocket extends EventEmitter {
  /** One behavior per constructed socket, consumed in dial order. */
  static queue: Array<(ws: ScriptedSocket) => void> = [];
  constructor(public url: string, public opts: { headers?: Record<string, string> }) {
    super();
    const behavior = ScriptedSocket.queue.shift();
    if (behavior) queueMicrotask(() => behavior(this));
  }
  terminate(): void { /* the probe calls this after settling; nothing to do */ }
}

function makeIdentity(): GatewayIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    version: 1,
    credential: 'c'.repeat(32),
    executorId: '97afab48-5204-4344-8fa4-e0a02b87eb23',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    enrolledAt: '2026-10-08T20:50:21.938Z',
  };
}

let dir = '';
const ENV_KEYS = ['NEXUS_EXECUTOR_STATE', 'EXECUTOR_TRANSPORT', 'GATEWAY_URL', 'GATEWAY_IDENTITY_PATH'] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-repair-test-'));
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  ScriptedSocket.queue = [];
  rmSync(dir, { recursive: true, force: true });
});

/** Identity + CLI state on disk, env pointed at them. */
function writeFixtures(identity: GatewayIdentity): { identityPath: string; statePath: string } {
  const identityPath = join(dir, 'gateway-identity.json');
  const statePath = join(dir, 'state.json');
  writeFileSync(identityPath, JSON.stringify(identity, null, 2), { mode: 0o600 });
  writeFileSync(statePath, JSON.stringify({
    transport: 'gateway',
    gatewayUrl: 'https://gw.example.com',
    name: 'test-executor',
    enrolledAt: identity.enrolledAt,
    identityPath,
  }));
  process.env.NEXUS_EXECUTOR_STATE = statePath;
  process.env.EXECUTOR_TRANSPORT = 'gateway';
  process.env.GATEWAY_URL = 'https://gw.example.com';
  process.env.GATEWAY_IDENTITY_PATH = identityPath;
  return { identityPath, statePath };
}

/** Deps that touch nothing outside this process. */
function hermeticDeps(overrides: Partial<RepairDeps> = {}): RepairDeps {
  return {
    fetchImpl: (async () => new Response('{}', {
      status: 400,
      headers: { date: new Date().toUTCString() },
    })) as unknown as typeof fetch,
    webSocketImpl: ScriptedSocket as unknown as typeof WebSocket,
    lookup: async () => ({ address: '203.0.113.7' }),
    exec: ((_command: string, _args: string[]) => 'active\n') as unknown as typeof execFileSync,
    databaseCheck: async () => ({ ok: true, detail: 'SELECT 1 ok (injected)' }),
    ...overrides,
  };
}

const ROUTE_OK: RouteOutcome = { status: 400, dateSkewMs: 5, error: null };

const fast1011 = (heldMs = 312): ProbeOutcome => ({
  opened: true, closeCode: 1011, closeReason: '', httpStatus: null, error: null, heldMs, stable: false,
});
const auth1008 = (heldMs = 40): ProbeOutcome => ({
  opened: true, closeCode: 1008, closeReason: 'authentication_failed', httpStatus: null, error: null, heldMs, stable: false,
});
const stableProbe: ProbeOutcome = {
  opened: true, closeCode: null, closeReason: '', httpStatus: null, error: null, heldMs: 3000, stable: true,
};

// ------------------------------------------------------------ wire format

it('buildConnectHeaders signs a proof the hub can verify against the public key', () => {
  const identity = makeIdentity();
  const headers = buildConnectHeaders(identity);
  expect(headers.authorization).toBe(`Bearer ${identity.credential}`);
  const message = `NEXUS-GATEWAY-CONNECT v1\n${identity.credential}\n${headers['x-nexus-proof-ts']}\n${headers['x-nexus-proof-nonce']}`;
  expect(ed25519Verify(null, Buffer.from(message, 'utf8'), createPublicKey(identity.publicKeyPem), Buffer.from(headers['x-nexus-proof'], 'base64url'))).toBe(true);
  // Fresh nonce per attempt — a replayed proof would be rejected by the hub.
  expect(buildConnectHeaders(identity)['x-nexus-proof-nonce']).not.toBe(headers['x-nexus-proof-nonce']);
});

it('buildInvalidConnectHeaders is shape-canonical but cryptographically garbage', () => {
  const headers = buildInvalidConnectHeaders();
  expect(headers.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{32}$/);
  expect(Buffer.from(headers['x-nexus-proof-nonce'], 'base64url')).toHaveLength(16);
  expect(Buffer.from(headers['x-nexus-proof'], 'base64url')).toHaveLength(64);
});

// ----------------------------------------------------------------- probes

it('probeConnect records a fast server-side close', async () => {
  ScriptedSocket.queue = [
    (ws) => {
      ws.emit('open');
      setTimeout(() => ws.emit('close', 1011, Buffer.from('')), 20);
    },
  ];
  const outcome = await probeConnect('wss://gw.example.com/v1/connect', {}, { webSocketImpl: ScriptedSocket as unknown as typeof WebSocket, holdMs: 200 });
  expect(outcome.opened).toBe(true);
  expect(outcome.closeCode).toBe(1011);
  expect(outcome.stable).toBe(false);
  expect(outcome.heldMs).toBeLessThan(200);
});

it('probeConnect reports stable when the session holds', async () => {
  ScriptedSocket.queue = [(ws) => ws.emit('open')]; // never closed by the "server"
  const outcome = await probeConnect('wss://gw.example.com/v1/connect', {}, { webSocketImpl: ScriptedSocket as unknown as typeof WebSocket, holdMs: 200 });
  expect(outcome.opened).toBe(true);
  expect(outcome.stable).toBe(true);
});

it('probeConnect captures the HTTP status of a rejected upgrade', async () => {
  ScriptedSocket.queue = [
    (ws) => {
      ws.emit('error', new Error('Unexpected server response: 401'));
      ws.emit('close', 1006, Buffer.from(''));
    },
  ];
  const outcome = await probeConnect('wss://gw.example.com/v1/connect', {}, { webSocketImpl: ScriptedSocket as unknown as typeof WebSocket, holdMs: 200 });
  expect(outcome.opened).toBe(false);
  expect(outcome.httpStatus).toBe(401);
  expect(outcome.closeCode).toBe(1006);
});

// ---------------------------------------------------------- classification

it('sameFailureSignature matches only identical fast-close signatures', () => {
  expect(sameFailureSignature(fast1011(), fast1011(290))).toBe(true);
  expect(sameFailureSignature(fast1011(), auth1008())).toBe(false);
  expect(sameFailureSignature(fast1011(), stableProbe)).toBe(false);
});

it('classifies the verdict table', () => {
  const args = (over: Partial<Parameters<typeof classifyRepair>[0]>) => ({
    transport: 'gateway' as const,
    hasIdentity: true,
    gatewayUrl: 'https://gw.example.com',
    route: ROUTE_OK,
    valid: fast1011(),
    invalid: auth1008(),
    ...over,
  });
  expect(classifyRepair(args({ valid: stableProbe }))).toBe('healthy');
  expect(classifyRepair(args({ valid: auth1008(), invalid: null }))).toBe('identity-rejected');
  expect(classifyRepair(args({ valid: { ...fast1011(), opened: false, closeCode: 1006, httpStatus: 401 }, invalid: null }))).toBe('identity-rejected');
  expect(classifyRepair(args({}))).toBe('hub-session-open-failure');          // valid 1011, invalid rejected
  // The live 2026-10-13 signature: the gateway rejects garbage at the HTTP
  // upgrade (401) while the valid proof upgrades and then 1011s.
  expect(classifyRepair(args({ invalid: { ...auth1008(), opened: false, closeCode: 1006, httpStatus: 401, heldMs: 0 } }))).toBe('hub-session-open-failure');
  expect(classifyRepair(args({ invalid: fast1011(290) }))).toBe('hub-call-failure'); // both 1011
  expect(classifyRepair(args({ valid: null, invalid: null }))).toBe('inconclusive');
  expect(classifyRepair(args({ route: { status: 404, dateSkewMs: null, error: null }, valid: null, invalid: null }))).toBe('route-missing');
  expect(classifyRepair(args({ route: { status: 502, dateSkewMs: null, error: null }, valid: null, invalid: null }))).toBe('gateway-origin-down');
  expect(classifyRepair(args({ route: { status: null, dateSkewMs: null, error: 'fetch failed' }, valid: null, invalid: null }))).toBe('network-unreachable');
  expect(classifyRepair(args({ hasIdentity: false }))).toBe('not-paired');
  expect(classifyRepair(args({ transport: 'direct' }))).toBe('direct-transport');
  expect(classifyRepair(args({ valid: { ...fast1011(), closeCode: 1006 }, invalid: null }))).toBe('inconclusive');
});

// ------------------------------------------------------------- end-to-end

it('diagnoses a healthy chain end to end', async () => {
  writeFixtures(makeIdentity());
  ScriptedSocket.queue = [
    (ws) => ws.emit('open'), // valid proof: holds
    (ws) => { ws.emit('open'); setTimeout(() => ws.emit('close', 1008, Buffer.from('authentication_failed')), 10); },
  ];
  const result = await repairFromCli({ argv: ['--hold-ms', '200'], deps: hermeticDeps() });
  expect(result.report.verdict).toBe('healthy');
  expect(result.ok).toBe(true);
  expect(result.report.checks.filter((c) => c.status === 'fail')).toEqual([]);
  expect(result.text).toContain('diagnosis: healthy');
});

it('diagnoses the live 1011 signature: auth passes, session-open fails', async () => {
  writeFixtures(makeIdentity());
  ScriptedSocket.queue = [
    (ws) => { ws.emit('open'); setTimeout(() => ws.emit('close', 1011, Buffer.from('')), 20); },
    (ws) => { ws.emit('open'); setTimeout(() => ws.emit('close', 1008, Buffer.from('authentication_failed')), 10); },
  ];
  const result = await repairFromCli({ argv: ['--hold-ms', '200'], deps: hermeticDeps() });
  expect(result.report.verdict).toBe('hub-session-open-failure');
  expect(result.ok).toBe(false);
  expect(result.report.checks.find((c) => c.id === 'connect-valid')?.status).toBe('fail');
  expect(result.report.probes.valid?.closeCode).toBe(1011);
  expect(result.report.probes.invalid?.closeCode).toBe(1008);
  expect(result.text).toContain('schema_migrations');
});

it('diagnoses both probes failing identically as a hub call failure', async () => {
  writeFixtures(makeIdentity());
  ScriptedSocket.queue = [
    (ws) => { ws.emit('open'); setTimeout(() => ws.emit('close', 1011, Buffer.from('')), 20); },
    (ws) => { ws.emit('open'); setTimeout(() => ws.emit('close', 1011, Buffer.from('')), 15); },
  ];
  const result = await repairFromCli({ argv: ['--hold-ms', '200'], deps: hermeticDeps() });
  expect(result.report.verdict).toBe('hub-call-failure');
  expect(result.text).toContain('journalctl -u nexus-gateway');
});

it('flags a tampered identity and points at re-pairing', async () => {
  const identity = makeIdentity();
  identity.publicKeyPem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string;
  writeFixtures(identity);
  ScriptedSocket.queue = [
    (ws) => { ws.emit('open'); setTimeout(() => ws.emit('close', 1008, Buffer.from('authentication_failed')), 10); },
    (ws) => { ws.emit('open'); setTimeout(() => ws.emit('close', 1008, Buffer.from('authentication_failed')), 10); },
  ];
  const result = await repairFromCli({ argv: ['--hold-ms', '200'], deps: hermeticDeps() });
  const identityCheck = result.report.checks.find((c) => c.id === 'identity');
  expect(identityCheck?.status).toBe('fail');
  expect(identityCheck?.fix).toContain('re-pair');
  expect(result.report.verdict).toBe('identity-rejected');
});

it('emits a machine-readable report with --json', async () => {
  writeFixtures(makeIdentity());
  ScriptedSocket.queue = [
    (ws) => ws.emit('open'),
    (ws) => { ws.emit('open'); setTimeout(() => ws.emit('close', 1008, Buffer.from('authentication_failed')), 10); },
  ];
  const result = await repairFromCli({ argv: ['--json', '--hold-ms', '200'], deps: hermeticDeps() });
  const parsed = JSON.parse(result.text) as { verdict: string; ok: boolean; checks: unknown[] };
  expect(parsed.verdict).toBe('healthy');
  expect(parsed.ok).toBe(true);
  expect(Array.isArray(parsed.checks)).toBe(true);
});
