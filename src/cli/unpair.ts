import { existsSync, rmSync } from 'node:fs';
import { clearCliState, readCliState } from '../pairing/state.js';
import { makePrompter } from '../pairing/prompts.js';

/**
 * `nexus-executor unpair` — removes the credential (gateway identity file)
 * and clears the CLI state. Two-step on a live machine: the user must confirm
 * by typing the executor name. `--force` bypasses the confirmation (tests/CI).
 */

export interface UnpairOptions {
  argv: string[];
  prompt?: (q: string) => Promise<string>;
  force?: boolean;
}

export async function unpair(opts: UnpairOptions): Promise<string> {
  const state = readCliState();
  if (!state) return 'Not paired — nothing to unpair.';
  const force = opts.force || opts.argv.includes('--force');
  if (!force) {
    const ask = opts.prompt ?? makePrompter();
    const answer = await ask(`Really unpair "${state.name}" from ${state.transport}? Type the executor name to confirm:`);
    if (answer.trim() !== state.name) {
      return 'Aborted — name did not match.';
    }
  }
  if (state.transport === 'gateway' && state.identityPath && existsSync(state.identityPath)) {
    rmSync(state.identityPath, { force: true });
  }
  clearCliState();
  return `Unpaired "${state.name}". Run \`nexus-executor pair\` to re-pair.`;
}