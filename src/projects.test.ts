import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool, runModuleMigrations, defaultMigrationsDir } from './db.js';
import {
  autodetectRemote,
  getProject,
  listProjects,
  projectText,
  registerProject,
  removeProject,
  resolveGitRemote,
  validateDir,
  type ProjectDeps,
} from './projects.js';
import { execGit } from './workspace.js';

let pool: Pool;
let root: string;

beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL!);
  await pool.query('DROP SCHEMA IF EXISTS executor CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS platform CASCADE');
  await runModuleMigrations(pool, 'executor', 'executor', defaultMigrationsDir());
  await pool.query('DELETE FROM executor.projects');
  root = mkdtempSync(join(tmpdir(), 'nexus-exec-proj-'));
});

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await pool.end();
});

function deps(): ProjectDeps {
  return { pool, git: execGit };
}

function plainDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'file.txt'), 'hello\n');
  return dir;
}

async function gitDir(name: string): Promise<string> {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const init = await execGit(['init', '-b', 'main'], { cwd: dir });
  expect(init.code).toBe(0);
  // Give the repo an origin so autodetect has something to read.
  await execGit(['remote', 'add', 'origin', `https://github.com/example/${name}.git`], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  await execGit(['add', '-A', '--', '.'], { cwd: dir });
  const commit = await execGit(['commit', '-m', 'init'], { cwd: dir, env: { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } });
  expect(commit.code).toBe(0);
  return dir;
}

describe('autodetectRemote + resolveGitRemote', () => {
  it('reads the repo origin when present', async () => {
    const dir = await gitDir('gitA');
    expect(await autodetectRemote(execGit, dir)).toBe(`https://github.com/example/gitA.git`);
  });

  it('returns null for a plain non-git dir', async () => {
    const dir = plainDir('plainA');
    await expect(autodetectRemote(execGit, dir)).resolves.toBeNull();
  });

  it('resolveGitRemote prefers an explicit remote over autodetect', async () => {
    const dir = await gitDir('gitB');
    const out = await resolveGitRemote(execGit, { dirPath: dir, gitRemote: 'https://github.com/example/other.git' });
    expect(out).toBe('https://github.com/example/other.git');
  });

  it('autodetects when explicit is empty', async () => {
    const dir = await gitDir('gitC');
    const out = await resolveGitRemote(execGit, { dirPath: dir, gitRemote: null });
    expect(out).toBe(`https://github.com/example/gitC.git`);
  });
});

describe('validateDir', () => {
  it('rejects a missing directory', () => {
    expect(() => validateDir(join(root, 'nope'), null)).toThrow(/does not exist/);
  });

  it('accepts a plain dir without a remote', () => {
    const dir = plainDir('plainB');
    expect(() => validateDir(dir, null)).not.toThrow();
  });

  it('rejects a plain non-git dir when a remote was set', () => {
    const dir = plainDir('plainC');
    expect(() => validateDir(dir, 'https://github.com/example/x.git')).toThrow(/not a git repo/);
  });
});

describe('registerProject', () => {
  it('registers a git project autodetecting its origin remote', async () => {
    const dir = await gitDir('regA');
    const p = await registerProject(deps(), { name: 'regA', dirPath: dir });
    expect(p.dir_path).toBe(dir);
    expect(p.git_remote).toBe(`https://github.com/example/regA.git`);
    const found = await getProject(deps(), 'regA');
    expect(found?.name).toBe('regA');
  });

  it('allows a plain non-git dir with no remote (plain-dir work mode)', async () => {
    const dir = plainDir('regPlain');
    const p = await registerProject(deps(), { name: 'regPlain', dirPath: dir });
    expect(p.git_remote).toBeNull();
  });

  it('records optional build/run/test commands and prompt', async () => {
    const dir = plainDir('regCmds');
    const p = await registerProject(deps(), {
      name: 'regCmds', dirPath: dir, buildCommand: 'npm run build',
      runCommand: 'npm start', testCommand: 'npm test', customPrompt: 'Be careful.',
    });
    expect(p.build_command).toBe('npm run build');
    expect(p.run_command).toBe('npm start');
    expect(p.test_command).toBe('npm test');
    expect(p.custom_prompt).toBe('Be careful.');
  });

  it('upserts on duplicate name (re-register points at new dir)', async () => {
    const a = plainDir('dupA');
    const b = plainDir('dupB');
    await registerProject(deps(), { name: 'dup', dirPath: a });
    const again = await registerProject(deps(), { name: 'dup', dirPath: b });
    expect(again.dir_path).toBe(b);
    const projects = await listProjects(deps());
    expect(projects.filter((x) => x.name === 'dup')).toHaveLength(1);
  });

  it('rejects an empty / unsafe name', async () => {
    const dir = plainDir('badName');
    await expect(registerProject(deps(), { name: '  ', dirPath: dir })).rejects.toThrow(/name is required/);
    await expect(registerProject(deps(), { name: 'has space', dirPath: dir })).rejects.toThrow(/invalid project name/);
  });
});

describe('list/get/remove', () => {
  it('lists registered projects sorted by name and removes one', async () => {
    const a = plainDir('listA');
    const b = plainDir('listB');
    await registerProject(deps(), { name: 'zeta', dirPath: a });
    await registerProject(deps(), { name: 'alpha', dirPath: b });
    const listed = (await listProjects(deps())).map((x) => x.name);
    // alpha and zeta are both present and in full alphabetical order.
    const idx = (name) => listed.indexOf(name);
    expect(idx('alpha')).toBeGreaterThan(-1);
    expect(idx('zeta')).toBeGreaterThan(-1);
    expect(idx('alpha')).toBeLessThan(idx('zeta'));
    const removed = await removeProject(deps(), 'alpha');
    expect(removed).toBe(true);
    expect(await removeProject(deps(), 'alpha')).toBe(false);
    expect(await getProject(deps(), 'alpha')).toBeNull();
    expect((await listProjects(deps())).some((x) => x.name === 'zeta')).toBe(true);
  });
});

describe('projectText', () => {
  it('renders a readable listing with and without a remote', () => {
    const withRemote = projectText({ id: '1', name: 'n', dir_path: '/x', git_remote: 'https://r.git', build_command: null, run_command: null, test_command: null, custom_prompt: null });
    expect(withRemote).toContain('Project:  n');
    expect(withRemote).toContain('https://r.git');
    const noRemote = projectText({ id: '2', name: 'o', dir_path: '/y', git_remote: null, build_command: null, run_command: null, test_command: null, custom_prompt: null });
    expect(noRemote).toContain('no git remote');
  });
});