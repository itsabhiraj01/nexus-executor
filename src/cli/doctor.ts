import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readCliState } from '../pairing/state.js';
import { EXECUTOR_VERSION } from '../config.js';

/**
 * `nexus-executor doctor` — the operator's "why is it down" checker for the
 * pairing story: is it paired, via which transport, and is the credential
 * present. `--json` emits a structured report for automation.
 */

export interface DoctorResult {
  paired: boolean;
  transport: 'gateway' | 'direct' | null;
  name: string | null;
  version: string;
  identityPresent: boolean;
  notes: string[];
}

export async function doctor(opts: { argv: string[] }): Promise<string> {
  const { values } = parseArgs({ args: opts.argv, options: { json: { type: 'boolean', short: 'j' } } });
  const state = readCliState();
  const notes: string[] = [];

  const identity =
    state?.transport === 'gateway' && state.identityPath
      ? existsSync(state.identityPath)
      : state ? true : false;

  if (!state) notes.push('not paired — run `nexus-executor pair`');
  else if (state.transport === 'gateway' && identity) notes.push('gateway identity present');
  else if (state.transport === 'gateway' && !identity) notes.push('gateway identity MISSING — re-run `nexus-executor pair`');
  else notes.push('direct transport (token lives in the DB)');

  const result: DoctorResult = {
    paired: !!state,
    transport: state?.transport ?? null,
    name: state?.name ?? null,
    version: EXECUTOR_VERSION,
    identityPresent: identity,
    notes,
  };
  return values.json ? JSON.stringify(result, null, 2) : printDoctor(result);
}

function printDoctor(r: DoctorResult): string {
  return [
    `Paired:      ${r.paired ? 'yes' : 'no'}`,
    `Transport:   ${r.transport ?? '—'}`,
    `Name:        ${r.name ?? '—'}`,
    `Version:     ${r.version}`,
    `Identity:    ${r.identityPresent ? 'present' : 'missing'}`,
    ...r.notes.map((n) => `  · ${n}`),
  ].join('\n');
}