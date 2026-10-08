import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairFromCli } from './pair.js';

function tmpState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-executor-pair-'));
  process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
  return dir;
}

function clean(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.NEXUS_EXECUTOR_STATE;
  delete process.env.GATEWAY_IDENTITY_PATH;
}

describe('pairFromCli — gateway default, flags', () => {
  it('pairs with a gateway URL + code from flags without prompting', async () => {
    const dir = tmpState();
    process.env.GATEWAY_IDENTITY_PATH = join(dir, 'gw-identity.json');
    try {
      let hit = false;
      const result = await pairFromCli({
        argv: ['--gateway', 'https://gateway.example.com', '--code', 'ABC123'],
        fetchImpl: (async (_url, init) => new Response(JSON.stringify({ credential: 'c', executorId: 'exec_1' }))) as typeof fetch,
        prompt: async () => { throw new Error('should not prompt'); },
      });
      expect(result.transport).toBe('gateway');
      expect(result.executorId).toBe('exec_1');
      expect(existsSync(process.env.GATEWAY_IDENTITY_PATH as string)).toBe(true);
      void hit;
    } finally { clean(dir); }
  });

  it('prompts for a pairing code when none is given', async () => {
    const dir = tmpState();
    process.env.GATEWAY_IDENTITY_PATH = join(dir, 'gw-identity.json');
    try {
      const result = await pairFromCli({
        argv: ['--gateway', 'https://gateway.example.com'],
        fetchImpl: (async (_url, init) => new Response(JSON.stringify({ credential: 'c', executorId: 'exec_1' }))) as typeof fetch,
        prompt: async () => 'ABC123',
      });
      expect(result.pairingCode).toBe('ABC123');
    } finally { clean(dir); }
  });

  it('uses the direct transport when --hub is given', async () => {
    const dir = tmpState();
    try {
      let calledWith: { transport: string; hubUrl?: string } | null = null;
      const result = await pairFromCli({
        argv: ['--hub', 'https://hub.example.com', '--code', 'XYZ789'],
        prompt: async () => { throw new Error('should not prompt'); },
        pairImpl: async (req) => { calledWith = req; return { transport: req.transport, name: 'box' }; },
      });
      expect(result.transport).toBe('direct');
      expect(calledWith?.transport).toBe('direct');
      expect(calledWith?.hubUrl).toBe('https://hub.example.com');
      expect(result.hubUrl).toBe('https://hub.example.com');
    } finally { clean(dir); }
  });
});