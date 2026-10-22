import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusFromCli, type StatusDeps } from './status.js';

/**
 * `nexus-executor status` — the runtime sections are best-effort and PASSIVE
 * (systemctl/journalctl reads + a jobs query; it never dials the gateway).
 * All tests are hermetic: systemd and the journal are scripted via the
 * injectable `exec` seam, jobs via `jobsCheck`.
 */

function env(dir: string): void {
  process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
  process.env.GATEWAY_IDENTITY_PATH = join(dir, 'gw-identity.json');
}

const SYSTEMCTL_SHOW = [
  'ActiveState=active',
  'ExecMainPID=62975',
  'ActiveEnterTimestamp=Thu 2026-10-22 21:25:52 IST',
  '',
].join('\n');

/** Newest last. The flap signature: many losses, then a live open. */
function journal(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

const LOST = '{"level":40,"time":1792676207066,"closeCode":1008,"closeReason":"","sessionDurationMs":997,"error":"socket hang up","msg":"gateway session lost; reconnecting"}';
const OPENED = '{"level":30,"time":1792684554056,"url":"wss://gw.example.com","msg":"gateway WebSocket opened; awaiting gateway requests"}';

function hermeticDeps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    exec: ((command: string) => (command === 'systemctl' ? SYSTEMCTL_SHOW : journal([LOST, OPENED]))) as unknown as typeof execFileSync,
    jobsCheck: async () => ({
      counts: { running: 1, queued: 2, succeeded: 9 },
      active: [
        { id: '8f3c2a10-1111-2222-3333-444455556666', status: 'running', title: 'Fix the flaky checkout test', createdAt: '2026-10-22T20:55:00.000Z', startedAt: '2026-10-22T21:00:12.000Z' },
        { id: '9a1b2c3d-1111-2222-3333-444455556666', status: 'queued', title: 'Bump deps', createdAt: '2026-10-22T21:20:00.000Z', startedAt: null },
      ],
    }),
    ...overrides,
  };
}

describe('statusFromCli', () => {
  it('reports not paired when there is no state file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-status-'));
    env(dir);
    delete process.env.NEXUS_EXECUTOR_STATE;
    // With the override gone, cliStatePath falls back to $HOME — point it at
    // the tmpdir too so a genuinely paired development box cannot leak its
    // real state into this assertion.
    const home = process.env.HOME;
    process.env.HOME = dir;
    try {
      const out = await statusFromCli({ argv: [], deps: hermeticDeps() });
      expect(out).toContain('not paired');
    } finally {
      process.env.HOME = home;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports gateway-enrolled with --json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-status-'));
    env(dir);
    try {
      const { writeCliState } = await import('../pairing/state.js');
      writeCliState({ transport: 'gateway', gatewayUrl: 'https://gw.example.com', name: 'box', enrolledAt: '2026-10-07T00:00:00.000Z', identityPath: join(dir, 'gw-identity.json') });
      const out = await statusFromCli({ argv: ['--json'], deps: hermeticDeps() });
      const parsed = JSON.parse(out) as Record<string, unknown>;
      expect(parsed.transport).toBe('gateway');
      expect(parsed.name).toBe('box');
      expect(parsed.paired).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('renders service, connection and jobs/builds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-status-'));
    env(dir);
    try {
      const { writeCliState } = await import('../pairing/state.js');
      writeCliState({ transport: 'gateway', gatewayUrl: 'https://gw.example.com', name: 'box', enrolledAt: '2026-10-07T00:00:00.000Z', identityPath: join(dir, 'gw-identity.json') });
      const out = await statusFromCli({ argv: [], deps: hermeticDeps() });
      expect(out).toContain('Service:    active (pid 62975, since Thu 2026-10-22 21:25:52 IST)');
      expect(out).toMatch(/Connection: connected since \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(up \d/);
      expect(out).toContain('Jobs:       1 running, 2 queued, 9 succeeded (12 total)');
      expect(out).toContain('8f3c2a10');
      expect(out).toContain('Fix the flaky checkout test');
      expect(out).toContain('queued');
      expect(out).toContain('Bump deps');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('surfaces the connection error when the session is flapping', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-status-'));
    env(dir);
    try {
      const { writeCliState } = await import('../pairing/state.js');
      writeCliState({ transport: 'gateway', gatewayUrl: 'https://gw.example.com', name: 'box', enrolledAt: '2026-10-07T00:00:00.000Z', identityPath: join(dir, 'gw-identity.json') });
      // Journal where the LAST session event is a loss (with an error).
      const deps = hermeticDeps({
        exec: ((command: string) => (command === 'systemctl' ? SYSTEMCTL_SHOW : journal([OPENED, LOST]))) as unknown as typeof execFileSync,
      });
      const out = await statusFromCli({ argv: ['--json'], deps });
      const parsed = JSON.parse(out) as {
        connection: { state: string; detail: string; lastClose: { code: number | null; error: string | null; sessionMs: number | null } };
        gatewayOk: boolean;
      };
      expect(parsed.connection.state).toBe('reconnecting');
      expect(parsed.connection.detail).toContain('reconnecting');
      expect(parsed.connection.detail).toContain('close 1008');
      expect(parsed.connection.detail).toContain('error: socket hang up');
      expect(parsed.connection.lastClose).toMatchObject({ code: 1008, error: 'socket hang up', sessionMs: 997 });
      expect(parsed.gatewayOk).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('degrades gracefully when systemd, the journal and the database are unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-status-'));
    env(dir);
    try {
      const { writeCliState } = await import('../pairing/state.js');
      writeCliState({ transport: 'gateway', gatewayUrl: 'https://gw.example.com', name: 'box', enrolledAt: '2026-10-07T00:00:00.000Z', identityPath: join(dir, 'gw-identity.json') });
      const deps = hermeticDeps({
        exec: (() => { throw new Error('spawn journalctl ENOENT'); }) as unknown as typeof execFileSync,
        jobsCheck: async () => ({ counts: {}, active: [], error: 'ECONNREFUSED 127.0.0.1:5556' }),
      });
      const out = await statusFromCli({ argv: [], deps });
      expect(out).toContain('Connection: service log unavailable');
      expect(out).toContain('Jobs:       unavailable (ECONNREFUSED 127.0.0.1:5556)');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
