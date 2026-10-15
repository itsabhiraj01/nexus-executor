import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Nexus-owned supervised command runner (spec §Components §Tool runner).
 *
 * THE point of this module: a timed-out PROMISE is not cancellation. Every
 * command runs in its own detached process group so timeout and abort really
 * kill the shell AND its descendants (SIGTERM, grace, SIGKILL), the
 * environment is scrubbed to an explicit minimum (never a `process.env`
 * spread — the executor's database URL and credentials must not leak into
 * jobs), and captured output is bounded (the tail is kept; streaming to the
 * caller is intentionally NOT capped — the caller owns its own bounds).
 *
 * Confinement note (spec §Model policy and execution security): `cwd` +
 * scrubbed env are not a sandbox. The container boundary is a separate,
 * later concern — this module is the kill/deadline truth the container's own
 * commands also run through.
 */

export interface SupervisedCommandSpec {
  /** Shell string executed via `/bin/sh -c`. */
  command: string;
  /** Working directory; also exported as the scrubbed HOME. */
  cwd: string;
  /** Absolute cap for the whole command. Never extended by output. */
  timeoutMs: number;
  /** Captured-output cap in BYTES (stdout+stderr interleaved; tail kept). */
  maxOutputBytes: number;
  /** Extra keys copied from `process.env` when present (e.g. ['CI','LANG']). */
  envAllowlist?: string[];
  /** Explicit values, merged last — they win over the base and allowlist. */
  envOverrides?: Record<string, string>;
  /** Per-chunk stream (stdout+stderr in arrival order); never capped. */
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
}

export type CommandOutcome = 'success' | 'exit_nonzero' | 'timeout' | 'cancelled' | 'spawn_error';

export interface CommandResult {
  outcome: CommandOutcome;
  /** Exit code when the process exited; null when killed or not spawned. */
  code: number | null;
  /** Captured tail of the interleaved output (≤ maxOutputBytes). */
  output: string;
  truncated: boolean;
  durationMs: number;
}

/** Grace between the group's SIGTERM and its SIGKILL. */
const KILL_GRACE_MS = 2_000;

function scrubbedEnv(spec: SupervisedCommandSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: spec.cwd,
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'dumb',
  };
  for (const key of spec.envAllowlist ?? []) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, spec.envOverrides ?? {});
  return env;
}

export async function runSupervisedCommand(spec: SupervisedCommandSpec): Promise<CommandResult> {
  const startedAt = Date.now();
  return new Promise<CommandResult>((resolve) => {
    // All state/helpers exist BEFORE the spawn attempt: a synchronous spawn
    // throw must be able to settle('spawn_error') without touching
    // uninitialized bindings (review finding — TDZ landmine on that path).
    let child: ChildProcess | undefined;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    let tailTotal = 0;
    const tail: Buffer[] = [];
    let killArmed = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

    const killGroup = (signal: NodeJS.Signals): void => {
      try { if (child?.pid) process.kill(-child.pid, signal); } catch { /* group gone */ }
    };

    const armKill = (): void => {
      if (killArmed || settled) return;
      killArmed = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
    };

    const onAbort = (): void => {
      aborted = true;
      armKill();
    };

    function settle(outcome: CommandOutcome, code: number | null = null): void {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      spec.signal?.removeEventListener('abort', onAbort);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      resolve({
        outcome, code,
        output: Buffer.concat(tail).toString('utf8'),
        truncated, durationMs: Date.now() - startedAt,
      });
    }

    try {
      child = spawn('/bin/sh', ['-c', spec.command], {
        cwd: spec.cwd, env: scrubbedEnv(spec),
        // Own process group → the whole tree answers one kill(-pid).
        detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      settle('spawn_error');
      return;
    }

    const pushChunk = (chunk: Buffer): void => {
      spec.onOutput?.(chunk.toString('utf8'));
      tail.push(chunk);
      tailTotal += chunk.length;
      while (tailTotal > spec.maxOutputBytes && tail.length > 1) {
        tailTotal -= tail.shift()!.length;
        truncated = true;
      }
      if (tailTotal > spec.maxOutputBytes && tail.length === 1) {
        tail[0] = Buffer.from(tail[0]!.subarray(tailTotal - spec.maxOutputBytes));
        tailTotal = spec.maxOutputBytes;
        truncated = true;
      }
    };
    child.stdout?.on('data', pushChunk);
    child.stderr?.on('data', pushChunk);

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      armKill();
    }, spec.timeoutMs);
    timeoutTimer.unref?.();

    if (spec.signal?.aborted) onAbort();
    else spec.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', () => settle('spawn_error'));
    child.on('exit', (code) => {
      if (timedOut) settle('timeout');
      else if (aborted) settle('cancelled');
      else if (code === 0) settle('success', 0);
      else settle('exit_nonzero', code);
    });
  });
}
