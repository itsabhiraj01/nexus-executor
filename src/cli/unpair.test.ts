import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCliState } from '../pairing/state.js';
import { unpair } from './unpair.js';

describe('unpair', () => {
  it('removes the identity and state when confirmed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-unpair-'));
    const identity = join(dir, 'gw.json');
    process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
    writeCliState({ transport: 'gateway', gatewayUrl: 'https://g', name: 'box', enrolledAt: '2026-10-07T00:00:00.000Z', identityPath: identity });
    writeFileSync(identity, '{}');
    try {
      const out = await unpair({ argv: [], force: true });
      expect(out).toContain('Unpaired');
      expect(existsSync(identity)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('aborts when the confirming name does not match', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-unpair-'));
    const identity = join(dir, 'gw.json');
    process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
    writeCliState({ transport: 'gateway', gatewayUrl: 'https://g', name: 'box', enrolledAt: '2026-10-07T00:00:00.000Z', identityPath: identity });
    writeFileSync(identity, '{}');
    try {
      const out = await unpair({ argv: [], prompt: async () => 'wrong-name' });
      expect(out).toContain('Aborted');
      expect(existsSync(identity)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports when nothing is paired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-unpair-'));
    process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
    try {
      const out = await unpair({ argv: [] });
      expect(out).toContain('nothing to unpair');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});