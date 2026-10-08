import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readCliState } from '../pairing/state.js';
import { EXECUTOR_VERSION } from '../config.js';

/**
 * `nexus-executor status` — report pairing + runtime status from the CLI
 * state index and the credential store. First-run (no state file) prints a
 * helpful "not paired" message. `--json` emits a machine-readable object.
 */

export interface StatusCliOptions { argv: string[] }

export interface StatusReport {
  transport: 'gateway' | 'direct' | null;
  name: string | null;
  version: string;
  paired: boolean;
  enrolled?: boolean;
  gatewayOk?: boolean;
  gatewayUrl?: string | null;
  hubUrl?: string | null;
  identityPath?: string | null;
  pairedAt?: string | null;
  message?: string;
}

export async function statusFromCli(opts: StatusCliOptions): Promise<string> {
  const { values } = parseArgs({ args: opts.argv, options: { json: { type: 'boolean', short: 'j' } } });
  const state = readCliState();

  const base = {
    transport: state?.transport ?? null,
    name: state?.name ?? null,
    version: EXECUTOR_VERSION,
  };

  if (!state) {
    const report: StatusReport = { ...base, paired: false, message: 'not paired' };
    return values.json
      ? JSON.stringify(report)
      : `nexus-executor v${EXECUTOR_VERSION} — not paired (run \`nexus-executor pair\`)`;
  }

  if (state.transport === 'gateway') {
    const hasIdentity = state.identityPath ? existsSync(state.identityPath) : false;
    const report: StatusReport = {
      ...base,
      paired: true,
      enrolled: hasIdentity,
      gatewayOk: hasIdentity, // a full liveness check lives in `doctor`
      gatewayUrl: state.gatewayUrl,
      identityPath: state.identityPath,
      pairedAt: state.enrolledAt,
    };
    return values.json ? JSON.stringify(report) : statusText(report);
  }

  const report: StatusReport = {
    ...base,
    paired: true,
    hubUrl: state.hubUrl,
    pairedAt: state.pairedAt,
  };
  return values.json ? JSON.stringify(report) : statusText(report);
}

function statusText(r: StatusReport): string {
  return [
    `Executor:  ${r.name ?? '—'}`,
    `Transport: ${r.transport ?? '—'}`,
    `Version:   ${r.version ?? '—'}`,
    r.enrolled === false ? 'Enrolled:  no (identity file missing — run nexus-executor pair)' : `Enrolled:  yes`,
    r.gatewayUrl ? `Gateway:   ${r.gatewayUrl}` : '',
    r.hubUrl ? `Hub:       ${r.hubUrl}` : '',
    r.gatewayOk === false ? 'Gateway:   no live session (run nexus-executor doctor)' : '',
    r.pairedAt ? `Paired:    ${r.pairedAt}` : '',
  ].filter(Boolean).join('\n');
}