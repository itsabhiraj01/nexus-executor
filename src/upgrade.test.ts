import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { testConfig } from './testkit.js';
import {
  createUpgrader, resolveUpgradeCommand, UPGRADE_STALE_MS,
  type UpgradeSpawn, type UpgradeState,
} from './upgrade.js';

/**
 * The self-upgrade state machine, unit-tested with an injectable spawn + fs
 * time: command resolution, the single-flight lock (fresh 409 / stale
 * takeover), the detached spawn with its log, and the boot finalizer that
 * settles restarts the re-spawned process can never witness itself.
 */

let root: string;
const roots: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nexus-exec-upgrade-'));
  roots.push(root);
});

afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Record<string, unknown> = {}) {
  return testConfig(join(root, 'workspaces'), overrides);
}

function makeRepoDir(layout: 'full' | 'executor-only' = 'full'): string {
  const repoDir = join(root, `checkout-${layout}`);
  const scriptDir = layout === 'full' ? join(repoDir, 'executor', 'scripts') : join(repoDir, 'scripts');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, 'self-upgrade.sh'), '#!/usr/bin/env bash\necho upgrading\n');
  return repoDir;
}

interface SpawnRecord { file: string; args: string[]; env: NodeJS.ProcessEnv; logFd: number }

function fakeSpawn(pid = 4242): { spawn: UpgradeSpawn; calls: SpawnRecord[] } {
  const calls: SpawnRecord[] = [];
  return {
    calls,
    spawn: (file, args, options) => {
      calls.push({ file, args: [...args], env: options.env, logFd: options.logFd });
      return { pid, unref() {}, };
    },
  };
}

describe('resolveUpgradeCommand', () => {
  it('is null when nothing is configured', () => {
    expect(resolveUpgradeCommand(config())).toBeNull();
  });

  it('an explicit command wins and needs no repo', () => {
    expect(resolveUpgradeCommand(config({ upgradeCommand: 'make upgrade' })))
      .toEqual({ kind: 'shell', command: 'make upgrade' });
  });

  it('an explicit command wins over a repo dir too (the escape hatch)', () => {
    const repoDir = makeRepoDir();
    expect(resolveUpgradeCommand(config({ upgradeCommand: 'x', upgradeRepoDir: repoDir })))
      .toEqual({ kind: 'shell', command: 'x' });
  });

  it('resolves the shipped script in a full checkout, then an executor-only one', () => {
    const full = makeRepoDir('full');
    expect(resolveUpgradeCommand(config({ upgradeRepoDir: full })))
      .toEqual({ kind: 'script', path: join(full, 'executor', 'scripts', 'self-upgrade.sh') });
    const executorOnly = makeRepoDir('executor-only');
    expect(resolveUpgradeCommand(config({ upgradeRepoDir: executorOnly })))
      .toEqual({ kind: 'script', path: join(executorOnly, 'scripts', 'self-upgrade.sh') });
  });

  it('is null when the repo dir lacks the script', () => {
    mkdirSync(join(root, 'checkout-empty'), { recursive: true });
    expect(resolveUpgradeCommand(config({ upgradeRepoDir: join(root, 'checkout-empty') }))).toBeNull();
  });
});

describe('createUpgrader — start', () => {
  it('refuses politely when upgrades are not configured', () => {
    const upgrader = createUpgrader({ config: config() });
    expect(upgrader.configured()).toBeNull();
    const outcome = upgrader.start();
    expect(outcome).toMatchObject({ ok: false, statusCode: 400 });
    expect((outcome as { error: string }).error).toMatch(/EXECUTOR_UPGRADE_COMMAND|EXECUTOR_REPO_DIR/);
  });

  it('spawns the shell command detached with a log and records the running state', () => {
    const { spawn, calls } = fakeSpawn();
    const upgrader = createUpgrader({ config: config({ upgradeCommand: 'make upgrade' }), spawnImpl: spawn });
    expect(upgrader.configured()).toEqual({ kind: 'shell', command: 'make upgrade' });
    const outcome = upgrader.start();
    expect(outcome.ok).toBe(true);
    expect((outcome as { status: { phase: string } }).status.phase).toBe('running');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('bash');
    expect(calls[0]!.args).toEqual(['-c', 'make upgrade']);
    expect(typeof calls[0]!.logFd).toBe('number');
    // The machine's own env rides along; the state file location is pinned.
    expect(calls[0]!.env.EXECUTOR_UPGRADE_STATE_FILE).toBe(upgrader.paths.stateFile);

    const state = JSON.parse(readFileSync(upgrader.paths.stateFile, 'utf8')) as UpgradeState;
    expect(state.phase).toBe('running');
    expect(state.pid).toBe(4242);
    expect(state.command).toContain('make upgrade');
    expect(state.startedAt).toBeTruthy();
    expect(state.updatedAt).toBeTruthy();
  });

  it('runs a COPY of the shipped script — a git reset must not mutate the running interpreter', () => {
    const repoDir = makeRepoDir();
    const { spawn, calls } = fakeSpawn();
    const upgrader = createUpgrader({
      config: config({ upgradeRepoDir: repoDir, upgradeRef: 'stable', upgradeServiceName: 'svc', upgradeInstallDir: '/opt/exec' }),
      spawnImpl: spawn,
    });
    const outcome = upgrader.start();
    expect(outcome.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('bash');
    expect(calls[0]!.args).toHaveLength(1);
    const runCopy = calls[0]!.args[0]!;
    expect(runCopy).not.toContain('checkout');
    expect(readFileSync(runCopy, 'utf8')).toBe(readFileSync(join(repoDir, 'executor', 'scripts', 'self-upgrade.sh'), 'utf8'));
    // The script's knobs arrive through the environment.
    expect(calls[0]!.env.EXECUTOR_REPO_DIR).toBe(repoDir);
    expect(calls[0]!.env.EXECUTOR_UPGRADE_REF).toBe('stable');
    expect(calls[0]!.env.EXECUTOR_SERVICE_NAME).toBe('svc');
    expect(calls[0]!.env.EXECUTOR_INSTALL_DIR).toBe('/opt/exec');
    expect(calls[0]!.env.EXECUTOR_UPGRADE_STATE_FILE).toBe(upgrader.paths.stateFile);
  });

  it('single-flight: a fresh run is a 409, a stale one (older than UPGRADE_STALE_MS) is taken over', () => {
    const { spawn, calls } = fakeSpawn();
    let now = 1_000_000;
    const upgrader = createUpgrader({ config: config({ upgradeCommand: 'make upgrade' }), spawnImpl: spawn, now: () => now });
    expect(upgrader.start().ok).toBe(true);

    const second = upgrader.start();
    expect(second).toMatchObject({ ok: false, statusCode: 409 });
    expect((second as { error: string }).error).toMatch(/already running/i);
    expect(calls).toHaveLength(1);

    now += UPGRADE_STALE_MS + 1;
    const third = upgrader.start();
    expect(third.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('a spawn failure is a 500 and the state records it', () => {
    const upgrader = createUpgrader({
      config: config({ upgradeCommand: 'x' }),
      spawnImpl: () => { throw new Error('no bash here'); },
    });
    const outcome = upgrader.start();
    expect(outcome).toMatchObject({ ok: false, statusCode: 500 });
    const state = JSON.parse(readFileSync(upgrader.paths.stateFile, 'utf8')) as UpgradeState;
    expect(state.phase).toBe('failed');
    expect(state.error).toContain('no bash here');
  });
});

describe('createUpgrader — status + boot finalization', () => {
  it('reads idle when no state exists, and tails the log once it does', () => {
    const upgrader = createUpgrader({ config: config() });
    const idle = upgrader.status();
    expect(idle).toMatchObject({ phase: 'idle', startedAt: null, error: null, logTail: '' });

    mkdirSync(join(root, 'state'), { recursive: true });
  });

  it('caps the log tail to the last lines (bounded status payloads)', () => {
    const { spawn } = fakeSpawn();
    const upgrader = createUpgrader({ config: config({ upgradeCommand: 'x' }), spawnImpl: spawn });
    upgrader.start();
    const lines = Array.from({ length: 500 }, (_, index) => `line-${index}`).join('\n') + '\n';
    writeFileSync(upgrader.paths.logFile, lines);
    const status = upgrader.status();
    expect(status.logTail).toContain('line-499');
    expect(status.logTail).not.toContain('line-0\n');
    expect(status.phase).toBe('running');
  });

  it('boot finalizes restarting → done (startedAt preserved) and running → failed', () => {
    const { spawn } = fakeSpawn();
    const upgrader = createUpgrader({ config: config({ upgradeCommand: 'x' }), spawnImpl: spawn });
    upgrader.start();
    const started = JSON.parse(readFileSync(upgrader.paths.stateFile, 'utf8')) as UpgradeState;

    // restarting → done: the freshly booted process is the proof the restart landed.
    writeFileSync(upgrader.paths.stateFile, JSON.stringify({ ...started, phase: 'restarting' }));
    upgrader.finalizeAtBoot();
    const done = JSON.parse(readFileSync(upgrader.paths.stateFile, 'utf8')) as UpgradeState;
    expect(done.phase).toBe('done');
    expect(done.startedAt).toBe(started.startedAt);
    expect(done.error).toBeNull();

    // running → failed: the previous process died before the restart hand-off.
    writeFileSync(upgrader.paths.stateFile, JSON.stringify({ ...started, phase: 'running' }));
    upgrader.finalizeAtBoot();
    const failed = JSON.parse(readFileSync(upgrader.paths.stateFile, 'utf8')) as UpgradeState;
    expect(failed.phase).toBe('failed');
    expect(failed.error).toMatch(/died|restarted|interrupted/i);

    // done/failed are not the boot's business.
    writeFileSync(upgrader.paths.stateFile, JSON.stringify({ ...started, phase: 'done' }));
    upgrader.finalizeAtBoot();
    expect((JSON.parse(readFileSync(upgrader.paths.stateFile, 'utf8')) as UpgradeState).phase).toBe('done');
  });
});
