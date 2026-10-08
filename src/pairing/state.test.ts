import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCliState, writeCliState, clearCliState, type CliState } from './state.js';

function tmpState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-executor-state-'));
  const statePath = join(dir, 'state.json');
  process.env.NEXUS_EXECUTOR_STATE = statePath;
  return statePath;
}

function cleanup(): void {
  const p = process.env.NEXUS_EXECUTOR_STATE;
  if (p) rmSync(join(p, '..'), { recursive: true, force: true });
  delete process.env.NEXUS_EXECUTOR_STATE;
}

describe('cli state', () => {
  it('returns null when no state file exists', () => {
    tmpState();
    try {
      expect(readCliState()).toBeNull();
    } finally { cleanup(); }
  });

  it('round-trips a gateway state through write/read', () => {
    tmpState();
    try {
      const state: CliState = {
        transport: 'gateway',
        gatewayUrl: 'https://gateway.example.com',
        name: 'home-server',
        enrolledAt: '2026-10-07T00:00:00.000Z',
        identityPath: '/tmp/nexus-executor/data/gateway-identity.json',
      };
      writeCliState(state);
      expect(readCliState()).toEqual(state);
    } finally { cleanup(); }
  });

  it('clearCliState removes the file', () => {
    tmpState();
    try {
      writeCliState({ transport: 'direct', hubUrl: 'https://hub.example.com', name: 'x', pairedAt: '2026-10-07T00:00:00.000Z' });
      clearCliState();
      expect(readCliState()).toBeNull();
    } finally { cleanup(); }
  });
});