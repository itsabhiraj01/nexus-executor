import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from './workspace.js';

/**
 * execGit diagnostics: util.promisify(execFile) overwrites
 * err.stdout/err.stderr with '' on rejection, so a git that NEVER RAN
 * (missing cwd, binary not executable) surfaced as `git <cmd> failed` with
 * no detail at all. The runner must keep the spawn error message.
 */
describe('execGit spawn failures', () => {
  it('reports the spawn error when git cannot start (missing cwd)', async () => {
    const missing = join(tmpdir(), 'nexus-exec-definitely-missing-cwd');
    if (existsSync(missing)) rmSync(missing, { recursive: true, force: true });
    const result = await execGit(['read-tree', 'HEAD'], { cwd: missing });
    expect(result.code).not.toBe(0);
    expect((result.stderr || result.stdout).trim()).toContain('ENOENT');
  });

  it('keeps real git stderr for ordinary git failures', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-exec-not-a-repo-'));
    try {
      const result = await execGit(['read-tree', 'HEAD'], { cwd: dir });
      expect(result.code).not.toBe(0);
      expect((result.stderr || result.stdout).trim()).toContain('not a git repository');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
