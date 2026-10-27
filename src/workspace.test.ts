import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execGit } from './workspace.js';

it('kills verification descendants when the executor process dies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'executor-parent-death-'));
  const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/workspace.js')).href;
  const script = `import { runJobCommand } from ${JSON.stringify(moduleUrl)}; await runJobCommand('echo $$ > command.pid; sleep 60', ${JSON.stringify(dir)}, { PATH: process.env.PATH });`;
  const owner = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  let pid = 0;
  try {
    await expect.poll(() => existsSync(join(dir, 'command.pid'))).toBe(true);
    pid = Number(readFileSync(join(dir, 'command.pid'), 'utf8'));
    owner.kill('SIGKILL');
    await expect.poll(() => {
      try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.startsWith('Z'); }
      catch { return true; }
    }, { timeout: 2000 }).toBe(true);
  } finally {
    owner.kill('SIGKILL');
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

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
