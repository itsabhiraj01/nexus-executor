import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_AUTHOR } from './testkit.js';

/**
 * The shipped scripts/self-upgrade.sh, exercised for real against a
 * throwaway origin+clone: fetch/reset, the hub-tree build branch (a stub
 * tsc), the state-file hand-off to "restarting" and the systemctl restart —
 * with systemctl and tsc shimmed so nothing real restarts or compiles.
 * `git`, `node` and `rsync` run for real (available in the test env).
 * Both checkout layouts are covered: a nexus monorepo clone (executor/…)
 * and an executor-only clone (this repo — package.json at the root).
 */

const SCRIPT = new URL('../scripts/self-upgrade.sh', import.meta.url).pathname;
const GIT_ENV = { ...process.env, ...TEST_AUTHOR };

let root: string;
let originDir: string;
let machineDir: string;
let shimDir: string;
let systemctlLog: string;
let stateFile: string;
let installDir: string;

function git(args: string[], cwd: string): void {
  const run = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
}

/** Commit a file tree change into the ORIGIN (via a scratch clone) so the
 *  machine's checkout has something to fast-forward to. */
function publishVersion(version: string): void {
  const scratch = mkdtempSync(join(root, 'scratch-'));
  git(['clone', originDir, scratch], root);
  writeFileSync(join(scratch, 'executor', 'package.json'), JSON.stringify({ name: 'nexus-executor', version }, null, 2) + '\n');
  git(['add', '-A', '--', '.'], scratch);
  git(['commit', '-m', `release ${version}`], scratch);
  git(['push', 'origin', 'main'], scratch);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nexus-self-upgrade-script-'));

  // The "machine's dedicated checkout": a clone of a local bare origin.
  const seed = mkdtempSync(join(root, 'seed-'));
  writeFileSync(join(seed, 'README.md'), 'machine checkout fixture\n');
  mkdirSync(join(seed, 'executor'), { recursive: true });
  writeFileSync(join(seed, 'executor', 'package.json'), JSON.stringify({ name: 'nexus-executor', version: '0.4.0' }, null, 2) + '\n');
  // A hub-tree toolchain stub: `tsc` that "builds" dist/main.js.
  mkdirSync(join(seed, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(seed, 'node_modules', '.bin', 'tsc'), '#!/usr/bin/env bash\nmkdir -p dist\nprintf "built\\n" > dist/main.js\n');
  chmodSync(join(seed, 'node_modules', '.bin', 'tsc'), 0o755);
  // The shipped script itself must be inside the machine checkout.
  mkdirSync(join(seed, 'executor', 'scripts'), { recursive: true });
  cpSync(SCRIPT, join(seed, 'executor', 'scripts', 'self-upgrade.sh'));

  git(['init', '-b', 'main'], seed);
  git(['add', '-A', '--', '.'], seed);
  git(['commit', '-m', 'initial'], seed);
  originDir = join(root, 'origin.git');
  git(['init', '--bare', originDir], root);
  git(['remote', 'add', 'origin', originDir], seed);
  git(['push', '-u', 'origin', 'main'], seed);

  machineDir = join(root, 'machine');
  git(['clone', originDir, machineDir], root);

  // systemctl shim: records its argv, exits 0.
  shimDir = join(root, 'shim');
  mkdirSync(shimDir, { recursive: true });
  systemctlLog = join(root, 'systemctl.log');
  writeFileSync(join(shimDir, 'systemctl'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}\n`);
  chmodSync(join(shimDir, 'systemctl'), 0o755);

  stateFile = join(root, 'upgrade-state.json');
  installDir = join(root, 'install');

  publishVersion('0.5.0');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function runScript(env: Record<string, string>, scriptRel = join('executor', 'scripts', 'self-upgrade.sh')): { status: number | null; output: string } {
  const run = spawnSync('bash', [join(machineDir, scriptRel)], {
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, ...env },
    encoding: 'utf8',
  });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe('executor/scripts/self-upgrade.sh (real script, shimmed systemctl/tsc)', () => {
  it('fetch/resets, rebuilds, hands off "restarting" and restarts the service', () => {
    writeFileSync(stateFile, JSON.stringify({
      phase: 'running', startedAt: '2026-10-15T10:00:00.000Z', updatedAt: '2026-10-15T10:00:00.000Z',
      command: 'test', pid: 1, error: null,
    }));
    const run = runScript({
      EXECUTOR_REPO_DIR: machineDir,
      EXECUTOR_UPGRADE_REF: 'main',
      EXECUTOR_SERVICE_NAME: 'nexus-executor-test',
      EXECUTOR_UPGRADE_STATE_FILE: stateFile,
    });
    if (run.status !== 0) console.error(run.output); // debug aid on failure
    expect(run.status).toBe(0);

    // The machine checkout fast-forwarded and rebuilt.
    const pkg = JSON.parse(readFileSync(join(machineDir, 'executor', 'package.json'), 'utf8')) as { version: string };
    expect(pkg.version).toBe('0.5.0');
    expect(readFileSync(join(machineDir, 'executor', 'dist', 'main.js'), 'utf8')).toContain('built');

    // The state preserved startedAt and flipped to restarting.
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { phase: string; startedAt: string; updatedAt: string };
    expect(state.phase).toBe('restarting');
    expect(state.startedAt).toBe('2026-10-15T10:00:00.000Z');
    expect(state.updatedAt > '2026-10-15T10:00:00.000Z').toBe(true);

    // systemctl was asked to reload + restart THIS service.
    expect(readFileSync(systemctlLog, 'utf8')).toBe('--user daemon-reload\n--user restart nexus-executor-test\n');
  });

  it('refuses loudly when EXECUTOR_REPO_DIR is not a git checkout', () => {
    const plain = mkdtempSync(join(root, 'plain-'));
    const run = runScript({ EXECUTOR_REPO_DIR: plain, EXECUTOR_UPGRADE_STATE_FILE: stateFile });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('not a git checkout');
  });

  it('rsyncs into a differing EXECUTOR_INSTALL_DIR, preserving its persistent state', () => {
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, '.env'), 'DATABASE_URL=postgres://kept\n');
    mkdirSync(join(installDir, 'data'), { recursive: true });
    writeFileSync(join(installDir, 'data', 'marker.txt'), 'persistent\n');
    const run = runScript({
      EXECUTOR_REPO_DIR: machineDir,
      EXECUTOR_INSTALL_DIR: installDir,
      EXECUTOR_UPGRADE_STATE_FILE: '',
    });
    if (run.status !== 0) console.error(run.output); // debug aid on failure
    expect(run.status).toBe(0);
    // Code arrived; persistent state survived.
    expect(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8'))).toMatchObject({ version: '0.5.0' });
    expect(readFileSync(join(installDir, '.env'), 'utf8')).toBe('DATABASE_URL=postgres://kept\n');
    expect(readFileSync(join(installDir, 'data', 'marker.txt'), 'utf8')).toBe('persistent\n');
    expect(existsSync(join(installDir, 'dist', 'main.js'))).toBe(true);
  });

  it('upgrades an EXECUTOR-ONLY checkout (package.json at the root — nexus-executor.git)', () => {
    // The standalone lineage's layout: the repo IS the executor. Build its
    // own tiny origin+clone (own toolchain at the root) so the main
    // monorepo-layout fixture stays untouched by the reset.
    const seed = mkdtempSync(join(root, 'solo-seed-'));
    writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'nexus-executor', version: '0.3.2' }, null, 2) + '\n');
    mkdirSync(join(seed, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(seed, 'node_modules', '.bin', 'tsc'), '#!/usr/bin/env bash\nmkdir -p dist\nprintf "built-solo\\n" > dist/main.js\n');
    chmodSync(join(seed, 'node_modules', '.bin', 'tsc'), 0o755);
    mkdirSync(join(seed, 'scripts'), { recursive: true });
    cpSync(SCRIPT, join(seed, 'scripts', 'self-upgrade.sh'));
    git(['init', '-b', 'main'], seed);
    git(['add', '-A', '--', '.'], seed);
    git(['commit', '-m', 'initial'], seed);
    const soloOrigin = join(root, 'solo-origin.git');
    git(['init', '--bare', soloOrigin], root);
    git(['remote', 'add', 'origin', soloOrigin], seed);
    git(['push', '-u', 'origin', 'main'], seed);
    const solo = join(root, 'solo-machine');
    git(['clone', soloOrigin, solo], root);
    // Publish a new root package.json so there is something to fetch.
    writeFileSync(join(seed, 'package.json'), JSON.stringify({ name: 'nexus-executor', version: '1.0.0' }, null, 2) + '\n');
    git(['add', '-A', '--', '.'], seed);
    git(['commit', '-m', 'release 1.0.0'], seed);
    git(['push', 'origin', 'main'], seed);

    const run = spawnSync('bash', [join(solo, 'scripts', 'self-upgrade.sh')], {
      env: {
        ...process.env,
        PATH: `${shimDir}:${process.env.PATH}`,
        EXECUTOR_REPO_DIR: solo,
        EXECUTOR_UPGRADE_REF: 'main',
        EXECUTOR_SERVICE_NAME: 'nexus-executor-solo-test',
        EXECUTOR_UPGRADE_STATE_FILE: '',
      },
      encoding: 'utf8',
    });
    if (run.status !== 0) console.error(`${run.stdout}${run.stderr}`); // debug aid on failure
    expect(run.status).toBe(0);
    expect(JSON.parse(readFileSync(join(solo, 'package.json'), 'utf8'))).toMatchObject({ version: '1.0.0' });
    expect(readFileSync(join(solo, 'dist', 'main.js'), 'utf8')).toContain('built-solo');
    expect(readFileSync(systemctlLog, 'utf8')).toContain('--user restart nexus-executor-solo-test');
  });
});
