import { describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { execGit, linkNodeModules, prepareWorktree } from './workspace.js';

it('fresh worktrees resolve project Fastify before ancestor executor Fastify', async () => {
  const root = mkdtempSync('/tmp/opencode/executor-dependencies-');
  const repoRoot = join(root, 'project');
  const executor = join(root, 'executor');
  const put = (file: string, text: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  try {
    put(join(repoRoot, '.gitignore'), 'node_modules/\n');
    put(join(repoRoot, 'node_modules/fastify/package.json'), '{"version":"5.12.3"}');
    put(join(executor, 'node_modules/fastify/package.json'), '{"version":"5.12.5"}');
    for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'seed']]) {
      expect((await execGit(args, { cwd: repoRoot })).code).toBe(0);
    }
    const prepared = await prepareWorktree(execGit, { repoRoot, worktreeRoot: join(executor, 'data/worktrees') }, { jobName: 'deps' });
    linkNodeModules(repoRoot, prepared.path);
    const require = createRequire(join(prepared.path, 'probe.cjs'));
    expect(require('fastify/package.json').version).toBe('5.12.3');
    expect((await execGit(['status', '--porcelain'], { cwd: prepared.path })).stdout).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['directory', 'symlink'])('links leaves from a source %s, remaps workspace packages, and preserves local dependencies', (source) => {
  const root = mkdtempSync('/tmp/opencode/executor-links-');
  const repo = join(root, 'repo');
  const worktree = join(root, 'worktree');
  const put = (file: string, text = '{}') => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  try {
    if (source === 'symlink') {
      mkdirSync(repo, { recursive: true });
      mkdirSync(join(root, 'installed'));
      symlinkSync(join(root, 'installed'), join(repo, 'node_modules'));
    }
    put(join(repo, 'node_modules/@vendor/package/index.js'), 'module.exports = "vendor";');
    put(join(repo, 'node_modules/tool/bin.js'), 'tool');
    mkdirSync(join(repo, 'node_modules/.bin'));
    symlinkSync('../tool/bin.js', join(repo, 'node_modules/.bin/tool'));
    for (const name of ['@nexus/local', '@other/local', 'unscoped']) {
      put(join(repo, 'packages', name, 'index.js'), 'module.exports = "source";');
      put(join(worktree, 'packages', name, 'index.js'), 'module.exports = "worktree";');
      mkdirSync(dirname(join(repo, 'node_modules', name)), { recursive: true });
      const from = join(repo, 'packages', name);
      const to = join(repo, 'node_modules', name);
      symlinkSync(name === '@nexus/local' ? relative(realpathSync(dirname(to)), from) : from, to);
    }
    put(join(worktree, 'node_modules/local-only/index.js'), 'local');
    put(join(worktree, 'node_modules/@vendor/local-only/index.js'), 'local scoped');
    put(join(repo, 'node_modules/@vendor/override/index.js'), 'source');
    put(join(worktree, 'node_modules/@vendor/override/index.js'), 'job local');
    put(join(repo, 'node_modules/override/index.js'), 'source');
    put(join(worktree, 'node_modules/override/index.js'), 'job local');
    put(join(repo, 'node_modules/.bin/override'), 'source');
    put(join(worktree, 'node_modules/.bin/override'), 'job local');
    linkNodeModules(repo, worktree);
    for (const container of ['', '@vendor', '@nexus', '@other', '.bin']) {
      expect(lstatSync(join(worktree, 'node_modules', container)).isSymbolicLink()).toBe(false);
    }
    const require = createRequire(join(worktree, 'probe.cjs'));
    for (const name of ['@nexus/local', '@other/local', 'unscoped']) {
      expect(require(name)).toBe('worktree');
      expect(realpathSync(join(worktree, 'node_modules', name))).toBe(join(worktree, 'packages', name));
    }
    expect(realpathSync(join(worktree, 'node_modules/.bin/tool'))).toBe(realpathSync(join(repo, 'node_modules/tool/bin.js')));
    // Simulate package-manager leaf unlink without installing in either repo.
    rmSync(join(worktree, 'node_modules/@vendor/package'));
    rmSync(join(worktree, 'node_modules/.bin/tool'));
    expect(readFileSync(join(repo, 'node_modules/@vendor/package/index.js'), 'utf8')).toContain('vendor');
    expect(readFileSync(join(repo, 'node_modules/tool/bin.js'), 'utf8')).toBe('tool');
    linkNodeModules(repo, worktree);
    expect(require('@vendor/package')).toBe('vendor');
    expect(readFileSync(join(worktree, 'node_modules/.bin/tool'), 'utf8')).toBe('tool');
    expect(readFileSync(join(worktree, 'node_modules/local-only/index.js'), 'utf8')).toBe('local');
    expect(readFileSync(join(worktree, 'node_modules/@vendor/local-only/index.js'), 'utf8')).toBe('local scoped');
    for (const leaf of ['override/index.js', '@vendor/override/index.js', '.bin/override']) {
      expect(readFileSync(join(worktree, 'node_modules', leaf), 'utf8')).toBe('job local');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['', '@vendor', '.bin'])('rejects a symlinked dependency container %j without writing through it', (container) => {
  const root = mkdtempSync('/tmp/opencode/executor-containers-');
  try {
    const repo = join(root, 'repo');
    const worktree = join(root, 'worktree');
    const outside = join(root, 'outside');
    mkdirSync(join(repo, 'node_modules/@vendor/package'), { recursive: true });
    mkdirSync(join(repo, 'node_modules/.bin'), { recursive: true });
    writeFileSync(join(repo, 'node_modules/.bin/tool'), 'tool');
    mkdirSync(dirname(join(worktree, 'node_modules', container)), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel'), 'unchanged');
    symlinkSync(outside, join(worktree, 'node_modules', container));
    expect(() => linkNodeModules(repo, worktree)).toThrow('Dependency container must be a real directory');
    expect(existsSync(join(outside, 'package'))).toBe(false);
    expect(existsSync(join(outside, 'tool'))).toBe(false);
    expect(existsSync(join(outside, '@vendor'))).toBe(false);
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('does nothing for projects without installed dependencies', () => {
  const root = mkdtempSync('/tmp/opencode/executor-no-deps-');
  try {
    linkNodeModules(join(root, 'repo'), join(root, 'worktree'));
    expect(existsSync(join(root, 'worktree'))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
