import { existsSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Pool } from 'pg';
import { execGit } from './workspace.js';

/**
 * Executor-owned project registry. The executor is the authority on where a
 * project's working copy lives (`dir_path`, mandatory, absolute on THIS
 * machine) and what git remote it tracks (`git_remote`, optional — autodetected
 * from the repo's `origin` when unset). The hub references these by name/id at
 * dispatch instead of shipping hub-side paths, so an executor never trusts a
 * raw path from the network.
 *
 * The two entry points share one core:
 *  - `registerProject` / `removeProject` / `listProjects` — the DAO (pool + git
 *    runner injected so the git part is testable without a repo).
 *  - `projectFromCli` / `projectsFromCli` — the `nexus-executor project…`
 *    subcommands.
 */

export interface ExecutorProject {
  id: string;
  name: string;
  dir_path: string;
  /** Autodetected from the repo's `origin` when registration left it unset. */
  git_remote: string | null;
  build_command: string | null;
  run_command: string | null;
  test_command: string | null;
  custom_prompt: string | null;
}

export interface ProjectDeps {
  pool: Pool;
  /** Injected so tests can stub git; defaults to the real `git` runner. */
  git?: GitFn;
}

export type GitFn = (args: readonly string[], options?: { cwd?: string | null }) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface RegisterProjectInput {
  name: string;
  dirPath: string;
  gitRemote?: string | null;
  buildCommand?: string | null;
  runCommand?: string | null;
  testCommand?: string | null;
  customPrompt?: string | null;
}

function git(deps: ProjectDeps): GitFn {
  return deps.git ?? execGit;
}

/** The repo's configured `origin` URL, or null when it isn't a git repo /
 *  has no origin. Never throws. */
export async function autodetectRemote(gitRun: GitFn, dirPath: string): Promise<string | null> {
  const probe = await gitRun(['remote', 'get-url', 'origin'], { cwd: dirPath });
  if (probe.code !== 0) return null;
  const url = probe.stdout.trim();
  return url || null;
}

/** Resolve the effective remote for a registration: explicit, or autodetect
 *  from the repo's `origin` when the dir is under git. Null when neither. */
export async function resolveGitRemote(gitRun: GitFn, input: { dirPath: string; gitRemote?: string | null }): Promise<string | null> {
  const explicit = input.gitRemote?.trim();
  if (explicit) return explicit;
  return autodetectRemote(gitRun, input.dirPath);
}

/** Validate the dir exists, is a directory, and (when a remote is set) is a
 *  git work tree. Throws a human-readable error otherwise. */
export function validateDir(dirPath: string, gitRemote: string | null): void {
  if (!dirPath || !dirPath.trim()) throw new Error('dir path is required');
  const p = dirPath.trim();
  if (!existsSync(p)) throw new Error(`directory does not exist: ${p}`);
  if (!statSync(p).isDirectory()) throw new Error(`not a directory: ${p}`);
  if (gitRemote && !existsSync(`${p}/.git`)) {
    // Allow `.git` to be a FILE (a git worktree's gitdir pointer).
    throw new Error(`dir is not a git repo but a remote was set: ${p} (git worktree's .git may be a file — register with --dir pointing at the worktree root)`);
  }
}

export async function registerProject(deps: ProjectDeps, input: RegisterProjectInput): Promise<ExecutorProject> {
  const name = input.name.trim();
  const dirPath = input.dirPath.trim();
  if (!name) throw new Error('project name is required');
  if (/[^A-Za-z0-9_.-]/.test(name)) {
    throw new Error(`invalid project name ${JSON.stringify(name)}: use letters, digits, _ . -`);
  }
  const gitRun = git(deps);
  const remote = await resolveGitRemote(gitRun, { dirPath, gitRemote: input.gitRemote });
  validateDir(dirPath, remote);
  const { rows } = await deps.pool.query<ExecutorProject>(
    `INSERT INTO executor.projects (name, dir_path, git_remote, build_command, run_command, test_command, custom_prompt)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (name) DO UPDATE SET
       dir_path = EXCLUDED.dir_path,
       git_remote = EXCLUDED.git_remote,
       build_command = EXCLUDED.build_command,
       run_command = EXCLUDED.run_command,
       test_command = EXCLUDED.test_command,
       custom_prompt = EXCLUDED.custom_prompt,
       updated_at = NOW()
     RETURNING *`,
    [name, dirPath, remote, input.buildCommand ?? null, input.runCommand ?? null, input.testCommand ?? null, input.customPrompt ?? null],
  );
  return rows[0]!;
}

export async function removeProject(deps: ProjectDeps, name: string): Promise<boolean> {
  const { rowCount } = await deps.pool.query(`DELETE FROM executor.projects WHERE name = $1`, [name.trim()]);
  return (rowCount ?? 0) > 0;
}

export async function listProjects(deps: ProjectDeps): Promise<ExecutorProject[]> {
  const { rows } = await deps.pool.query<ExecutorProject>(
    `SELECT id, name, dir_path, git_remote, build_command, run_command, test_command, custom_prompt
     FROM executor.projects ORDER BY name ASC`,
  );
  return rows;
}

export async function getProject(deps: ProjectDeps, name: string): Promise<ExecutorProject | null> {
  const { rows } = await deps.pool.query<ExecutorProject>(
    `SELECT id, name, dir_path, git_remote, build_command, run_command, test_command, custom_prompt
     FROM executor.projects WHERE name = $1`,
    [name.trim()],
  );
  return rows[0] ?? null;
}

/* ── CLI subcommands ---------------------------------------------------- */

export interface ProjectCliOptions { argv: string[] }

const PROJECT_HELP = `nexus-executor project — manage executor-owned projects

Usage:
  nexus-executor project add <name> --dir <abs-path> [--remote <url>] [--build <cmd>] [--run <cmd>] [--test <cmd>] [--prompt <text>]
  nexus-executor project list
  nexus-executor project show <name>
  nexus-executor project rm <name>
  nexus-executor project help

The --remote is optional: when omitted and the directory is a git repo, the
remote is autodetected from its 'origin'. A plain non-git directory is allowed
unless a --remote is set.
`;

export async function projectsFromCli(deps: ProjectDeps, argv: string[]): Promise<string> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'add': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          dir: { type: 'string' },
          remote: { type: 'string' },
          build: { type: 'string' },
          run: { type: 'string' },
          test: { type: 'string' },
          prompt: { type: 'string' },
        },
        allowPositionals: true,
      });
      const name = positionals[0];
      if (!values.dir) return 'project add: --dir <abs-path> is required\n\n' + PROJECT_HELP;
      if (!name) return 'project add: a project <name> is required\n\n' + PROJECT_HELP;
      const project = await registerProject(deps, {
        name,
        dirPath: values.dir,
        gitRemote: values.remote ?? null,
        buildCommand: values.build ?? null,
        runCommand: values.run ?? null,
        testCommand: values.test ?? null,
        customPrompt: values.prompt ?? null,
      });
      return `Registered project "${project.name}" -> ${project.dir_path}${project.git_remote ? ` (remote ${project.git_remote})` : ' (no remote)'}.`;
    }
    case 'show': {
      const name = rest.join(' ').trim();
      if (!name) return 'project show: a project <name> is required\n\n' + PROJECT_HELP;
      const project = await getProject(deps, name);
      if (!project) return `No project named "${name}" (see 'nexus-executor project list').`;
      return projectText(project);
    }
    case 'list': {
      const projects = await listProjects(deps);
      if (projects.length === 0) return 'No executor-owned projects registered (run \'nexus-executor project add <name> --dir <abs-path>\').';
      return projects.map(projectText).join('\n\n');
    }
    case 'rm': {
      const name = rest.join(' ').trim();
      if (!name) return 'project rm: a project <name> is required\n\n' + PROJECT_HELP;
      const removed = await removeProject(deps, name);
      return removed ? `Removed project "${name}".` : `No project named "${name}" removed.`;
    }
    case 'help':
    default:
      return PROJECT_HELP;
  }
}

export function projectText(project: ExecutorProject): string {
  const lines = [
    `Project:  ${project.name}`,
    `Dir:      ${project.dir_path}`,
    `Remote:   ${project.git_remote ?? '— (no git remote; plain dir work only)'}`,
  ];
  if (project.build_command) lines.push(`Build:    ${project.build_command}`);
  if (project.run_command) lines.push(`Run:      ${project.run_command}`);
  if (project.test_command) lines.push(`Test:     ${project.test_command}`);
  if (project.custom_prompt) lines.push(`Prompt:   ${project.custom_prompt}`);
  return lines.join('\n');
}