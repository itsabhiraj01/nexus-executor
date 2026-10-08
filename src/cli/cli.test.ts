import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.js';

describe('nexus-executor dispatch', () => {
  it('prints help for an unknown subcommand and exits non-zero', async () => {
    let code = 0;
    const out = await runCli(['frobnicate'], { exit: (c) => { code = c; } });
    expect(out).toContain('Usage');
    expect(code).toBe(2);
  });

  it('prints version for `version`', async () => {
    const out = await runCli(['version']);
    expect(out).toMatch(/^nexus-executor v?/);
  });

  it('prints a status summary for a bare invocation (not paired)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-cli-'));
    process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
    try {
      const out = await runCli([]);
      expect(out).toContain('not paired');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.NEXUS_EXECUTOR_STATE;
    }
  });
});