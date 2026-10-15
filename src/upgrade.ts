import { spawn } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ExecutorConfig } from './config.js';

/**
 * Hub-triggered self-upgrades (docs/remote-executors.md §Upgrading an
 * executor from the hub): the hub only ever ASKS (`POST /api/v1/upgrade` /
 * gateway op `executor.upgrade`); the machine decides what runs — always an
 * operator-configured command station: either `EXECUTOR_UPGRADE_COMMAND`
 * verbatim (the rsync/copy/docker escape hatch) or, when `EXECUTOR_REPO_DIR`
 * points at the machine's own git checkout, the shipped
 * `scripts/self-upgrade.sh` (fetch → reset → rebuild → restart).
 * No command text crosses the wire — same posture as
 * `EXECUTOR_DEPLOY_COMMAND`.
 *
 * The run is DETACHED (its own session, stdio folded into a persistent log
 * under data/) because it ends by asking systemd to restart THIS process —
 * and systemd's control-group kill would take a still-attached child down
 * with the old service. State survives the restart the same way: the
 * trigger writes {phase:'running'}, the shipped script writes
 * {phase:'restarting'} as its last act, and the freshly booted executor
 * finalizes (restarting → done; a leftover running → failed, the previous
 * process having died before the hand-off).
 */

export type ResolvedUpgrade =
  | { kind: 'shell'; command: string }
  | { kind: 'script'; path: string };

/**
 * What a trigger would run, or null when the operator configured nothing
 * (or `EXECUTOR_REPO_DIR` lacks the shipped script). The capability gate
 * (`selfUpgrade`) advertises exactly this resolution, so the console's
 * Upgrade affordance never appears for a machine that would only refuse.
 */
export function resolveUpgradeCommand(
  config: Pick<ExecutorConfig, 'upgradeCommand' | 'upgradeRepoDir'>,
  exists: (path: string) => boolean = existsSync,
): ResolvedUpgrade | null {
  if (config.upgradeCommand) return { kind: 'shell', command: config.upgradeCommand };
  if (config.upgradeRepoDir) {
    // A full nexus checkout carries executor/ inside it; an executor-only
    // checkout IS the executor directory. Both are legitimate homes.
    const candidates = [
      resolve(config.upgradeRepoDir, 'executor', 'scripts', 'self-upgrade.sh'),
      resolve(config.upgradeRepoDir, 'scripts', 'self-upgrade.sh'),
    ];
    const found = candidates.find((candidate) => exists(candidate));
    if (found) return { kind: 'script', path: found };
  }
  return null;
}

export type UpgradePhase = 'idle' | 'running' | 'restarting' | 'done' | 'failed';

/** The state-file shape (`upgrade-state.json`). */
export interface UpgradeState {
  phase: UpgradePhase;
  startedAt: string | null;
  updatedAt: string | null;
  /** What the operator would recognize: the command line / script path. */
  command: string | null;
  pid: number | null;
  error: string | null;
}

/** What opStatus reports: the state plus a bounded tail of the run's log. */
export interface UpgradeStatus extends UpgradeState {
  logTail: string;
}

/** A running/restarting lock older than this no longer blocks a trigger
 *  (the process died without settling — the takeover logs a warning). */
export const UPGRADE_STALE_MS = 30 * 60_000;
/** The tail status responses carry: bounded, console-displayable. */
const LOG_TAIL_LINES = 20;
const LOG_TAIL_MAX_BYTES = 256 * 1024;
const LOG_TAIL_LINE_MAX = 300;

export interface UpgradeSpawnOptions { env: NodeJS.ProcessEnv; logFd: number }
/** A spawned upgrade child. `pid` mirrors ChildProcess's OPTIONAL pid
 *  (spawn failures leave it undefined) — declared optional so the real
 *  `spawn()` implementation type-checks; readers coalesce (`?? null`). */
export interface UpgradeSpawned { pid?: number | undefined; unref(): void }
export type UpgradeSpawn = (file: string, args: string[], options: UpgradeSpawnOptions) => UpgradeSpawned;

export interface UpgradeDeps {
  config: ExecutorConfig;
  stateFile?: string;
  logFile?: string;
  exists?: (path: string) => boolean;
  spawnImpl?: UpgradeSpawn;
  now?: () => number;
}

export interface UpgradeStartOutcome {
  ok: boolean;
  statusCode?: number;
  error?: string;
  status?: UpgradeStatus;
}

export interface Upgrader {
  paths: { stateFile: string; logFile: string };
  /** What a trigger would run right now (null = not configured). */
  configured(): ResolvedUpgrade | null;
  /** Fire the run (409 on a live lock, 400 when unconfigured). */
  start(): UpgradeStartOutcome;
  /** State + bounded log tail for status responses. */
  status(): UpgradeStatus;
  /** Settle the phases a restart proved: restarting → done, running → failed. */
  finalizeAtBoot(): void;
}

/** data/ survives deploys (the rsync excludes it) — state and log live there. */
function defaultPaths(config: ExecutorConfig): { stateFile: string; logFile: string } {
  const dir = resolve(config.workspaceRoot, '..');
  return { stateFile: join(dir, 'upgrade-state.json'), logFile: join(dir, 'upgrade.log') };
}

const IDLE: UpgradeState = { phase: 'idle', startedAt: null, updatedAt: null, command: null, pid: null, error: null };

function readState(stateFile: string): UpgradeState {
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as Partial<UpgradeState>;
    const phase = typeof raw.phase === 'string' && ['idle', 'running', 'restarting', 'done', 'failed'].includes(raw.phase)
      ? raw.phase as UpgradePhase
      : 'idle';
    return {
      phase,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      command: typeof raw.command === 'string' ? raw.command : null,
      pid: typeof raw.pid === 'number' ? raw.pid : null,
      error: typeof raw.error === 'string' ? raw.error : null,
    };
  } catch {
    return { ...IDLE };
  }
}

function writeState(stateFile: string, state: UpgradeState): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, stateFile);
}

function readLogTail(logFile: string): string {
  try {
    const size = statSync(logFile).size;
    let content: string;
    if (size <= LOG_TAIL_MAX_BYTES) {
      content = readFileSync(logFile, 'utf8');
    } else {
      // A chatty build log must not bloat every status ping: read back from the end.
      const fd = openSync(logFile, 'r');
      try {
        const buffer = Buffer.alloc(LOG_TAIL_MAX_BYTES);
        const read = readSync(fd, buffer, 0, LOG_TAIL_MAX_BYTES, size - LOG_TAIL_MAX_BYTES);
        content = buffer.subarray(0, read).toString('utf8');
      } finally {
        closeSync(fd);
      }
    }
    const lines = content.split('\n').filter((line) => line.length > 0);
    return lines.slice(-LOG_TAIL_LINES).map((line) => line.slice(0, LOG_TAIL_LINE_MAX)).join('\n');
  } catch {
    return '';
  }
}

/** The real spawn: a detached session leader whose stdio folds into the
 *  log, unref'd so this process may exit (or be restarted) mid-upgrade. */
const defaultSpawn: UpgradeSpawn = (file, args, options) => {
  const child = spawn(file, args, {
    detached: true,
    stdio: ['ignore', options.logFd, options.logFd],
    env: options.env,
  });
  child.unref();
  return child;
};

export function createUpgrader(deps: UpgradeDeps): Upgrader {
  const paths = deps.stateFile && deps.logFile
    ? { stateFile: deps.stateFile, logFile: deps.logFile }
    : defaultPaths(deps.config);
  const exists = deps.exists ?? existsSync;
  const spawnImpl = deps.spawnImpl ?? defaultSpawn;
  const now = deps.now ?? Date.now;

  const iso = (ms: number) => new Date(ms).toISOString();
  const log = (line: string): void => {
    mkdirSync(dirname(paths.logFile), { recursive: true });
    const fd = openSync(paths.logFile, 'a');
    try {
      writeFileSync(fd, `self-upgrade[upgrader]: ${line}\n`);
    } finally {
      closeSync(fd);
    }
  };

  const status = (): UpgradeStatus => ({ ...readState(paths.stateFile), logTail: readLogTail(paths.logFile) });

  return {
    paths,

    configured(): ResolvedUpgrade | null {
      return resolveUpgradeCommand(deps.config, exists);
    },

    start(): UpgradeStartOutcome {
      const resolved = resolveUpgradeCommand(deps.config, exists);
      if (!resolved) {
        return {
          ok: false, statusCode: 400,
          error: 'Executor upgrades are not configured on this machine — set EXECUTOR_UPGRADE_COMMAND, or EXECUTOR_REPO_DIR to use the shipped self-upgrade script (docs/remote-executors.md §Upgrading).',
        };
      }

      const current = readState(paths.stateFile);
      if ((current.phase === 'running' || current.phase === 'restarting') && current.updatedAt) {
        const ageMs = now() - Date.parse(current.updatedAt);
        if (Number.isFinite(ageMs) && ageMs < UPGRADE_STALE_MS) {
          return {
            ok: false, statusCode: 409,
            error: `An upgrade is already running (phase "${current.phase}" since ${current.startedAt ?? 'unknown'}) — let it finish, or wait out the ${Math.round(UPGRADE_STALE_MS / 60000)}-minute stale lock.`,
          };
        }
        log(`taking over a stale "${current.phase}" lock (updated ${current.updatedAt})`);
      }

      const display = resolved.kind === 'shell' ? resolved.command : `${resolved.path} (repo ${deps.config.upgradeRepoDir})`;
      const startedAt = iso(now());
      let child: UpgradeSpawned;
      const logFd = (() => {
        mkdirSync(dirname(paths.logFile), { recursive: true });
        return openSync(paths.logFile, 'a');
      })();
      try {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          EXECUTOR_UPGRADE_STATE_FILE: paths.stateFile,
          ...(deps.config.upgradeRepoDir ? { EXECUTOR_REPO_DIR: deps.config.upgradeRepoDir } : {}),
          EXECUTOR_UPGRADE_REF: deps.config.upgradeRef,
          EXECUTOR_SERVICE_NAME: deps.config.upgradeServiceName,
          ...(deps.config.upgradeInstallDir ? { EXECUTOR_INSTALL_DIR: deps.config.upgradeInstallDir } : {}),
        };
        // A script inside the repo gets copied OUT first: the upgrade's own
        // `git reset --hard` must never change the bytes bash is reading.
        const command: [file: string, args: string[]] = resolved.kind === 'shell'
          ? ['bash', ['-c', resolved.command]]
          : (() => {
              const copy = join(dirname(paths.stateFile), 'self-upgrade.run.sh');
              copyFileSync(resolved.path, copy);
              return ['bash', [copy]];
            })();
        writeFileSync(logFd, `\n=== upgrade started ${startedAt} (${display}) ===\n`);
        child = spawnImpl(command[0], command[1] as string[], { env, logFd });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeState(paths.stateFile, { phase: 'failed', startedAt, updatedAt: iso(now()), command: display, pid: null, error: message });
        return { ok: false, statusCode: 500, error: `Could not start the upgrade: ${message}` };
      } finally {
        closeSync(logFd);
      }

      writeState(paths.stateFile, {
        phase: 'running', startedAt, updatedAt: startedAt,
        command: display, pid: child.pid ?? null, error: null,
      });
      return { ok: true, status: status() };
    },

    status,

    finalizeAtBoot(): void {
      const current = readState(paths.stateFile);
      if (current.phase === 'restarting') {
        // We ARE the restarted process — the restart this state announced has landed.
        writeState(paths.stateFile, { ...current, phase: 'done', updatedAt: iso(now()), error: null });
        log('boot finalization: upgrade done (the restart landed)');
        return;
      }
      if (current.phase === 'running') {
        // A boot with a still-"running" state means the previous process
        // died before the script reached its restart hand-off (a crash, a
        // machine reboot, an OOM — the log holds the detail).
        writeState(paths.stateFile, {
          ...current, phase: 'failed', updatedAt: iso(now()),
          error: 'The executor restarted (or died) before the upgrade reached its restart hand-off — see the upgrade log on the machine.',
        });
        log('boot finalization: a stale "running" upgrade was marked failed');
      }
    },
  };
}
