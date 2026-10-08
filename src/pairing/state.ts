import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * CLI pairing state index.
 *
 * NOT a credential store — it holds no secrets, only an index pointing at
 * the real credential: a FILE PATH to the gateway identity (gateway
 * transport) or nothing (direct transport; the token hash lives in the DB).
 * Every control frontend (`status`, `unpair`, `doctor`, the service boot)
 * reads this one place regardless of transport.
 *
 * Stored in `~/.config/nexus-executor/state.json`; overridable via
 * `NEXUS_EXECUTOR_STATE` for tests/containers.
 */

export type CliState =
  | { transport: 'gateway'; gatewayUrl: string; name: string; enrolledAt: string; identityPath: string }
  | { transport: 'direct'; hubUrl: string; name: string; pairedAt: string };

/** Path to the CLI state index. NEXUS_EXECUTOR_STATE overrides (tests/containers). */
export function cliStatePath(): string {
  return process.env.NEXUS_EXECUTOR_STATE
    ?? (process.env.HOME ? `${process.env.HOME}/.config/nexus-executor/state.json` : '');
}

export function readCliState(): CliState | null {
  const p = cliStatePath();
  if (!p || !existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as CliState;
    if (raw && (raw.transport === 'gateway' || raw.transport === 'direct')) return raw;
    return null;
  } catch {
    return null;
  }
}

export function writeCliState(state: CliState): void {
  const p = cliStatePath();
  if (!p) throw new Error('No CLI state path (HOME or NEXUS_EXECUTOR_STATE is unset).');
  mkdirSync(dirname(p), { recursive: true });
  // 0600: the index is not secret, but is sensitive config.
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function clearCliState(): void {
  const p = cliStatePath();
  if (p && existsSync(p)) rmSync(p, { force: true });
}