import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from './doctor.js';

describe('doctor', () => {
  it('reports not paired when no state exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-doctor-'));
    process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
    try {
      const out = await doctor({ argv: ['--json'] });
      const r = JSON.parse(out) as { paired: boolean; notes: string[] };
      expect(r.paired).toBe(false);
      expect(r.notes.some((n) => n.includes('not paired'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports a gateway identity present when enrolled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-doctor-'));
    const identity = join(dir, 'gw.json');
    process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
    const { writeFileSync } = await import('node:fs');
    const { writeCliState } = await import('../pairing/state.js');
    writeCliState({ transport: 'gateway', gatewayUrl: 'https://g', name: 'box', enrolledAt: '2026-10-07T00:00:00.000Z', identityPath: identity });
    writeFileSync(identity, '{}');
    try {
      const out = await doctor({ argv: ['--json'] });
      const r = JSON.parse(out) as { paired: boolean; identityPresent: boolean };
      expect(r.paired).toBe(true);
      expect(r.identityPresent).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});