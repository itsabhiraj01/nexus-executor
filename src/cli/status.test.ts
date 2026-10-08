import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusFromCli } from './status.js';

function env(dir: string): void {
  process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
  process.env.GATEWAY_IDENTITY_PATH = join(dir, 'gw-identity.json');
}

describe('statusFromCli', () => {
  it('reports not paired when there is no state file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-status-'));
    env(dir);
    delete process.env.NEXUS_EXECUTOR_STATE;
    try {
      const out = await statusFromCli({ argv: [] });
      expect(out).toContain('not paired');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports gateway-enrolled with --json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-status-'));
    env(dir);
    try {
      const { writeCliState } = await import('../pairing/state.js');
      writeCliState({ transport: 'gateway', gatewayUrl: 'https://gw.example.com', name: 'box', enrolledAt: '2026-10-07T00:00:00.000Z', identityPath: join(dir, 'gw-identity.json') });
      const out = await statusFromCli({ argv: ['--json'] });
      const parsed = JSON.parse(out) as Record<string, unknown>;
      expect(parsed.transport).toBe('gateway');
      expect(parsed.name).toBe('box');
      expect(parsed.paired).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});