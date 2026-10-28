import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { validateJobBody } from './ops.js';
import { execGit, materializeJobSkills } from './workspace.js';

const content = '# Hub skill\n';
const dataBase64 = Buffer.from(content).toString('base64');
const sha256 = createHash('sha256').update(`SKILL.md\0${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const skill = { id: 'review', files: [{ path: 'SKILL.md', dataBase64 }], sha256 };

it('validates delivered skills before accepting a job', () => {
  const job = { jobId: 'test', prompt: 'work', project: null, agent: { name: 'Reviewer', opencodeAgent: 'reviewer', markdown: 'Review', mcp: null, skills: [skill] } };
  expect(validateJobBody(job).spec?.agent?.skills).toEqual([skill]);
  expect(validateJobBody({ ...job, agent: { ...job.agent, skills: [{ ...skill, files: [{ path: '../escape', dataBase64 }] }] } }).error).toMatch(/path/i);
  expect(validateJobBody({ ...job, agent: { ...job.agent, skills: [{ ...skill, sha256: '0'.repeat(64) }] } }).error).toMatch(/digest/i);
});

it('overwrites a tracked worktree skill without changing the source checkout or branch contents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-skill-overlay-'));
  const repo = join(dir, 'repo');
  const worktree = join(dir, 'job');
  const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  try {
    mkdirSync(join(repo, '.opencode/skills/review'), { recursive: true });
    git(['init']);
    writeFileSync(join(repo, '.opencode/skills/review/SKILL.md'), '# Repo version\n');
    writeFileSync(join(repo, '.opencode/skills/review/stale.md'), 'Stale');
    git(['add', '-A']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base']);
    git(['worktree', 'add', '-b', 'job', worktree]);
    await materializeJobSkills(execGit, worktree, [skill]);
    expect(readFileSync(join(worktree, '.opencode/skills/review/SKILL.md'), 'utf8')).toBe(content);
    expect(() => readFileSync(join(worktree, '.opencode/skills/review/stale.md'))).toThrow();
    expect(readFileSync(join(repo, '.opencode/skills/review/SKILL.md'), 'utf8')).toBe('# Repo version\n');
    expect(git(['status', '--porcelain'], worktree)).toBe('');
    git(['add', '-A'], worktree);
    expect(git(['diff', '--cached', '--name-only'], worktree)).toBe('');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('refuses a linked worktree skill root without writing outside the worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-skill-link-'));
  try {
    mkdirSync(join(dir, 'job/.opencode'), { recursive: true });
    mkdirSync(join(dir, 'outside'), { recursive: true });
    symlinkSync(join(dir, 'outside'), join(dir, 'job/.opencode/skills'));
    await expect(materializeJobSkills(execGit, join(dir, 'job'), [skill])).rejects.toThrow(/Unsafe skill destination/);
    expect(() => readFileSync(join(dir, 'outside/review/SKILL.md'))).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
