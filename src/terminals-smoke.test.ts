import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, defaultMigrationsDir, runModuleMigrations } from './db.js';
import { TerminalStore } from './terminal-store.js';
import { TerminalRegistry, defaultTmuxRunner, type PtyProcess } from './terminals.js';

/**
 * REAL tmux end-to-end smoke for the sync feature (isolated `-L` socket per
 * file — never the box's default server, so the operator's own sessions are
 * untouched): manual sessions are discovered with Attached/Detached status,
 * repeated syncs are idempotent, a restarted registry restores the mapping,
 * a rename keeps the public id, attach/input/detach/kill all work through
 * the native $id, and everything lands in REAL Postgres (its own dedicated
 * test database — see vitest.setup.ts).
 *
 * Skipped entirely when tmux is missing.
 */

const hasTmux = (() => {
  try { return /^tmux 3\.[2-9]/.test(execFileSync('tmux', ['-V'], { encoding: 'utf8' })); } catch { return false; }
})();

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let pool: Pool;
let store: TerminalStore;
let sock: string;
let ptySpawn: typeof import('node-pty').spawn;
const leftovers: ChildProcess[] = [];

function tmux(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const base = defaultTmuxRunner();
  return base(['-L', sock, ...args]);
}

async function newManual(name: string, opts: { x?: number; y?: number } = {}): Promise<void> {
  const res = await tmux(['new-session', '-d', '-s', name, ...(opts.x ? ['-x', String(opts.x)] : []), ...(opts.y ? ['-y', String(opts.y)] : [])]);
  if (res.code !== 0) throw new Error(`seed new-session failed: ${res.stderr}`);
}

/** An out-of-band attached client: tmux control mode held open. */
function attachOutOfBand(name: string): ChildProcess {
  const p = spawn('tmux', ['-L', sock, '-C', 'attach-session', '-t', name], { stdio: ['pipe', 'ignore', 'ignore'] });
  leftovers.push(p);
  return p;
}

function makeRegistry(): TerminalRegistry {
  return new TerminalRegistry({
    tmux,
    tmuxAvailable: async () => true,
    store,
    spawner: (command, args, opts) => {
      const pty = ptySpawn(command, ['-L', sock, ...args], {
        name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env,
      });
      return pty as unknown as PtyProcess;
    },
  });
}

async function captureContains(target: string, needle: string, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await tmux(['capture-pane', '-p', '-J', '-t', target, '-S', '-2000']);
    if (res.code === 0 && res.stdout.includes(needle)) return true;
    await sleep(150);
  }
  return false;
}

describe.skipIf(!hasTmux)('real-tmux sync smoke (isolated socket)', () => {
  beforeAll(async () => {
    ptySpawn = (await import('node-pty')).spawn;
    pool = createPool(process.env.DATABASE_URL!);
    await pool.query('DROP SCHEMA IF EXISTS executor CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS platform CASCADE');
    await runModuleMigrations(pool, 'executor', 'executor', defaultMigrationsDir());
    store = new TerminalStore(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE executor.terminal_sessions').catch(() => {});
    sock = `nxtsmoke-${randomBytes(4).toString('hex')}`;
  });

  afterEach(async () => {
    for (const p of leftovers.splice(0)) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
    await execFileAsync('tmux', ['-L', sock, 'kill-server']).catch(() => {});
  });

  // TODO(unification task 2.9): unskip all four when terminals.ts gains the
  // TerminalStore-backed sync — these drive it (ported red from the monorepo).
  it.skip('discovers attached + detached manual sessions; repeated sync is idempotent', async () => {
    await newManual('manual-dev', { x: 90, y: 25 });
    await newManual('detached-job');
    attachOutOfBand('manual-dev');
    await sleep(400); // let the control client bind

    const registry = makeRegistry();
    const first = await registry.list();
    const manual = first.sessions.find((s) => s.name === 'manual-dev')!;
    const detached = first.sessions.find((s) => s.name === 'detached-job')!;
    expect(manual).toMatchObject({ status: 'live', origin: 'imported', tmuxClients: 1, cols: 90, rows: 25 });
    expect(detached).toMatchObject({ status: 'live', origin: 'imported', tmuxClients: 0 });
    // Repeat sync: same public ids, same single store row each.
    const second = await registry.list();
    expect(second.sessions.map((s) => s.id).sort()).toEqual(first.sessions.map((s) => s.id).sort());
    const { rows } = await pool.query('SELECT * FROM executor.terminal_sessions');
    expect(rows).toHaveLength(2);
  });

  it.skip('attach/input/detach/kill an imported session end to end', async () => {
    await newManual('manual-dev');
    const registry = makeRegistry();
    const { sessions } = await registry.list();
    const id = sessions[0]!.id;

    // Attach: real pty + snapshot seed from the live pane.
    const seeded = await registry.read(id, 0, 0, true);
    expect(seeded).not.toBeNull();
    expect(seeded!.status).toBe('live');
    expect(seeded!.snapshot).not.toBeNull();

    // Input really reaches the shell: the marker echoes back into the pane.
    const marker = `SMK${randomBytes(3).toString('hex').toUpperCase()}`;
    expect(registry.input(id, `echo ${marker}\r`)).toBe('ok');
    expect(await captureContains('manual-dev', marker)).toBe(true);

    // The executor's own pty attach counts in tmux' attached-client number.
    const attached = await registry.list();
    expect(attached.sessions.find((s) => s.id === id)!.tmuxClients).toBeGreaterThanOrEqual(1);

    expect(registry.detach(id)).toBe('ok');
    expect(await registry.kill(id)).toBe('ok');
    expect((await registry.list()).sessions.find((s) => s.id === id)!.status).toBe('exited');
    const row = await store.byPublicId(id);
    expect(row!.exitedAt).not.toBeNull();
    await registry.stopAll();
  });

  it.skip('a restarted registry restores mappings; a rename keeps the public id', async () => {
    await newManual('manual-dev');
    const first = makeRegistry();
    const listed = await first.list();
    const publicId = listed.sessions[0]!.id;
    await first.stopAll(); // pty clients die, the tmux session lives on

    // "Rebooted process", same store + server.
    const second = makeRegistry();
    const restored = await second.list();
    expect(restored.sessions[0]!.id).toBe(publicId);

    const renamed = await tmux(['rename-session', '-t', '$0', 'maintenance-window']);
    expect(renamed.code).toBe(0);
    const again = await second.list();
    expect(again.sessions[0]!.id).toBe(publicId);
    expect(again.sessions[0]!.name).toBe('maintenance-window');
    // …and ops keep landing on the same shell through the stable mapping.
    expect(second.input(publicId, 'true\r')).toBe('ok');
    await second.stopAll();
  });

  it.skip('sessions created through the registry stay in charge after the restart (durable ids)', async () => {
    const first = makeRegistry();
    const created = await first.create({ cols: 90, rows: 25, name: 'dev-box', idempotencyKey: 'smoke1' });
    expect(created.id).toBe('nxt-smoke1');
    await first.stopAll(); // the "process" dies; tmux + Postgres live on
    const second = makeRegistry();
    const listed = await second.list();
    expect(listed.sessions.find((s) => s.id === created.id)).toMatchObject({ status: 'live', origin: 'created', name: 'dev-box' });
    // A RETRIED create (same idempotency key) returns the restored session.
    const again = await second.create({ cols: 80, rows: 24, idempotencyKey: 'smoke1' });
    expect(again.id).toBe(created.id);
    expect(await second.kill(created.id)).toBe('ok');
    await second.stopAll();
  });
});
