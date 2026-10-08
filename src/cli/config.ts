import { readCliState } from '../pairing/state.js';

/**
 * `nexus-executor config` — print the EFFECTIVE runtime config (CLI state
 * index + key env knobs). It is a reporting command, not a pairing wizard:
 * `.env` edits are left to the documented manual path. Secrets are masked —
 * URLs are printed as `set`/`(unset)`, never their value.
 */

export function configText(): string {
  const state = readCliState();
  const rows: string[] = ['Executor config:', `  transport   = ${state?.transport ?? '(not set)'}`];
  if (state && 'gatewayUrl' in state) rows.push(`  gatewayUrl  = ${state.gatewayUrl}`);
  if (state && 'hubUrl' in state) rows.push(`  hubUrl      = ${state.hubUrl}`);
  rows.push(`  name        = ${state?.name ?? '(not set)'}`);

  const knobs: Array<[string, boolean]> = [
    ['DATABASE_URL', !!process.env.DATABASE_URL],
    ['GATEWAY_URL', !!process.env.GATEWAY_URL],
    ['EXECUTOR_TRANSPORT', !!process.env.EXECUTOR_TRANSPORT],
    ['EXECUTOR_PUBLIC_URL', !!process.env.EXECUTOR_PUBLIC_URL],
    ['OPENCODE_BASE_URL', !!process.env.OPENCODE_BASE_URL],
  ];
  for (const [k, isSet] of knobs) {
    rows.push(`  ${k}${' '.repeat(Math.max(0, 15 - k.length))}= ${isSet ? 'set' : '(unset)'}`);
  }
  return rows.join('\n');
}