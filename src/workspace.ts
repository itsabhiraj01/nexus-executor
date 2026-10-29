import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

/**
 * Git worktree isolation for executor jobs — adapted from the hub's
 * `modules/builder/src/worktree.ts` (+ the exclude/sanitize helpers from
 * `attachments.ts`), reduced to what one job lifecycle needs and renamed
 * with plain job vocabulary.
 *
 * Every job gets its own git worktree (a private checkout on its own
 * branch), so parallel jobs can never edit each other's files: the OpenCode
 * session is created with `location.directory` pointing at the worktree,
 * verification commands run there, and the agent's work is committed on the
 * branch. When the hub calls the merge endpoint, the branch is merged back
 * into the base branch and the workspace removed.
 *
 * All git access goes through an injectable runner so the command sequences
 * are testable without a repository. The real runner shells out to `git`.
 *
 * Merge mechanics (no working tree is ever touched by the merge itself):
 *
 *  1. If the main checkout has uncommitted tracked changes AND sits on the
 *     base branch, they are checkpointed: a snapshot commit (temp index —
 *     the live index is never disturbed) advances the base branch to the
 *     current working-tree state. Skipped cleanly when the checkout is on
 *     another branch (the tree-less merge below does not care).
 *  2. `git merge-tree --write-tree --merge-base=<common ancestor>` three-way
 *     merges the branch into the base branch WITHOUT a working tree. The
 *     base is the branch's latest common ancestor with the base branch,
 *     re-resolved at merge time (falling back to the recorded base when git
 *     finds no common ancestor).
 *  3. The merged tree becomes a real merge commit (`commit-tree` with both
 *     parents) and the base ref advances via a compare-and-swap
 *     `update-ref`, so concurrent merges cannot clobber each other.
 *  4. The main checkout is synced (`reset --hard <base>`) when — and only
 *     when — it is checked out on the base branch, and the deploy command
 *     runs there.
 */

export interface GitExecOptions {
  cwd?: string | null;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Exact stdin bytes (UTF-8, including NUL-delimited paths), never a shell. */
  input?: string;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: readonly string[], options?: GitExecOptions) => Promise<GitResult>;

const execFileAsync = promisify(execFile);

/** Real git runner: `git <args>` on the host, never throws. */
export const execGit: GitRunner = async (args, options) => {
  try {
    const command = execFileAsync('git', args as string[], {
      cwd: options?.cwd ?? undefined,
      timeout: options?.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: mergedEnv(options?.env),
    });
    if (options?.input !== undefined) {
      // A git invocation rejecting its arguments may close stdin early;
      // surface its exit status rather than an unhandled stream EPIPE.
      command.child.stdin?.on('error', () => {});
      command.child.stdin?.end(options.input);
    }
    const { stdout, stderr } = await command;
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    // A spawn-level failure (cwd missing, git not executable) never runs
    // git: child_process rejects with a string errno code and util.promisify
    // has already overwritten err.stderr/err.stdout with '' — so the old
    // `err.stderr ?? err.message` chain hid the only explanation there is
    // ('spawn git ENOENT'). Surface the message for exactly that case.
    const spawnFailure = typeof err.code === 'string' && !(err.stderr || err.stdout);
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: spawnFailure ? (err.message ?? '') : (err.stderr ?? err.message ?? ''),
    };
  }
};

function mergedEnv(overrides?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
  return env;
}

/** Commit identity for everything the executor writes (config-independent —
 *  cloned project repos may have no git user configured). */
const EXECUTOR_AUTHOR: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Nexus Executor',
  GIT_AUTHOR_EMAIL: 'executor@nexus.local',
  GIT_COMMITTER_NAME: 'Nexus Executor',
  GIT_COMMITTER_EMAIL: 'executor@nexus.local',
};

export class WorkspaceError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(detail ? `${message}: ${detail}` : message);
  }
}

/**
 * A worktree carrying unresolved merge conflicts. Committing it would land
 * conflict markers on the base branch and break anything built from it, so
 * every commit path refuses it. Recovery: resolve the conflicts in the
 * worktree (or `git merge --abort` there), then commit/merge again.
 */
export class ConflictError extends WorkspaceError {
  constructor(readonly files: string[]) {
    super(
      'the worktree has unresolved merge conflicts',
      `${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}`,
    );
  }
}

async function mustGit(runner: GitRunner, args: readonly string[], options?: GitExecOptions): Promise<string> {
  const result = await runner(args, options);
  if (result.code !== 0) {
    throw new WorkspaceError(`git ${args[0]} failed`, (result.stderr || result.stdout).trim().slice(0, 400));
  }
  return result.stdout;
}

/** The snapshot a job's branch was cut from, the worktree and its branch. */
export interface PreparedWorktree {
  branch: string;
  path: string;
  /** The commit the worktree's branch was created from — recorded as the
   *  merge-base fallback (the live merge prefers the branch's current
   *  common ancestor with the base branch). */
  baseSha: string;
}

/** The checkout's current branch name, or its commit sha when detached. */
export async function resolveBaseRef(runner: GitRunner, repoRoot: string, configured?: string | null): Promise<string> {
  if (configured && configured.trim()) return configured.trim();
  const out = await mustGit(runner, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
  const branch = out.trim();
  if (branch && branch !== 'HEAD') return branch;
  return (await mustGit(runner, ['rev-parse', 'HEAD'], { cwd: repoRoot })).trim();
}

/**
 * A commit of the repo checkout's CURRENT working tree (tracked changes
 * plus untracked, non-ignored files), created through a temp index so
 * neither the live index nor the working tree is touched. This is the base
 * each job worktree branches from — "what the machine actually has right
 * now", including uncommitted in-flight work.
 */
export async function createSnapshotCommit(runner: GitRunner, repoRoot: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'nexus-exec-index-'));
  try {
    const env: Record<string, string | undefined> = { GIT_INDEX_FILE: join(tmp, 'index') };
    await mustGit(runner, ['read-tree', 'HEAD'], { cwd: repoRoot, env });
    await mustGit(runner, ['add', '-A', '--', '.'], { cwd: repoRoot, env });
    const tree = (await mustGit(runner, ['write-tree'], { cwd: repoRoot, env })).trim();
    return (await mustGit(runner, ['commit-tree', tree, '-p', 'HEAD', '-m', 'executor: workspace snapshot'],
      { cwd: repoRoot, env: { ...env, ...EXECUTOR_AUTHOR } })).trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Create a job's worktree on a snapshot base of the repo's current working
 * tree. Stale registrations (crashed runs) are pruned before adding.
 */
export async function prepareWorktree(
  runner: GitRunner,
  config: { repoRoot: string; worktreeRoot: string },
  input: { jobName: string },
): Promise<PreparedWorktree> {
  const branch = `job-${input.jobName}`;
  const path = join(config.worktreeRoot, `job-${input.jobName}`);
  const baseSha = await createSnapshotCommit(runner, config.repoRoot);
  mkdirSync(config.worktreeRoot, { recursive: true });
  // GIT_INDEX_FILE must NOT be set here — the worktree's own index would be
  // redirected.
  await runner(['worktree', 'prune'], { cwd: config.repoRoot });
  await mustGit(runner, ['worktree', 'add', '-b', branch, path, baseSha], { cwd: config.repoRoot });
  return { branch, path, baseSha };
}

/** Share installed project dependencies without installing in a job worktree.
 * node_modules, scopes and .bin remain real directories; only package/bin
 * leaves are symlinks, so package-manager rename/unlink cannot mutate the
 * source scope. Workspace links (in any scope, relative or absolute) point
 * into this checkout, never the source checkout's code/dist.
 * Re-entry fills missing links while preserving job-local dependencies.
 */
export function linkNodeModules(repoRoot: string, worktreePath: string): void {
  const src = join(repoRoot, 'node_modules');
  if (!existsSync(src)) return;
  const repo = realpathSync(repoRoot);
  const dst = join(worktreePath, 'node_modules');
  const stat = (path: string) => {
    try { return lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const directory = (path: string) => {
    const existing = stat(path);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw new WorkspaceError('Dependency container must be a real directory', path);
    }
    mkdirSync(path, { recursive: true });
  };
  const link = (from: string, to: string) => {
    if (stat(to)) return;
    const target = realpathSync(from);
    const local = relative(repo, target);
    const insideRepo = local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
    const installed = local.split(sep).includes('node_modules');
    const destination = insideRepo && !installed
      ? relative(dirname(to), join(worktreePath, local))
      : target;
    symlinkSync(destination, to);
  };
  directory(dst);
  for (const entry of readdirSync(src)) {
    if (entry.startsWith('.') && entry !== '.bin') continue;
    const from = join(src, entry);
    const to = join(dst, entry);
    if (entry === '.bin' || entry.startsWith('@')) {
      directory(to);
      for (const item of readdirSync(from)) {
        if (!item.startsWith('.')) link(join(from, item), join(to, item));
      }
    } else {
      link(from, to);
    }
  }
}

export interface JobCommit {
  committed: boolean;
  sha: string | null;
}

/** The paths git reports as unmerged (conflicted) in the worktree. `-z`
 *  keeps the paths unquoted (git C-quotes exotic names otherwise). */
export async function listUnmergedPaths(runner: GitRunner, worktreePath: string): Promise<string[]> {
  const out = await runner(['diff', '--name-only', '--diff-filter=U', '-z'], { cwd: worktreePath });
  if (out.code !== 0) return [];
  return out.stdout.split('\0').filter(Boolean);
}

/** The rebase/pull step shared by the `rebaseFirst` stage branch and the
 *  `job.rebase` op (spec 2026-10-15 §3.2/§4): merge the base ref into the
 *  job's live worktree. Remote `origin/<baseRef>` wins when an origin
 *  remote exists (freshly fetched, best effort); local-registered projects
 *  fall back to the branch tip itself. */
export interface PullBaseResult {
  status: 'up_to_date' | 'merged' | 'conflicts';
  /** Populated only for the conflicts outcome. */
  conflicts: string[];
  /** HEAD after a clean merge (null for up_to_date/conflicts). */
  mergeSha: string | null;
}

export async function pullBaseIntoWorktree(
  runner: GitRunner,
  input: { repoRoot: string; worktreePath: string; baseRef: string },
): Promise<PullBaseResult> {
  let source = input.baseRef;
  const remotes = await runner(['remote'], { cwd: input.worktreePath });
  if (remotes.code === 0 && remotes.stdout.split('\n').map((name) => name.trim()).includes('origin')) {
    await runner(['fetch', 'origin', input.baseRef], { cwd: input.worktreePath }); // best-effort freshness
    const remote = await runner(['rev-parse', '--verify', '--quiet', `origin/${input.baseRef}^{commit}`], { cwd: input.worktreePath });
    if (remote.code === 0 && remote.stdout.trim()) source = `origin/${input.baseRef}`;
  }
  const before = (await mustGit(runner, ['rev-parse', 'HEAD'], { cwd: input.worktreePath })).trim();
  const merge = await runner(['merge', '--no-edit', source], { cwd: input.worktreePath });
  if (merge.code === 0) {
    const after = (await mustGit(runner, ['rev-parse', 'HEAD'], { cwd: input.worktreePath })).trim();
    return { status: after === before ? 'up_to_date' : 'merged', conflicts: [], mergeSha: after === before ? null : after };
  }
  const conflicts = await listUnmergedPaths(runner, input.worktreePath);
  if (conflicts.length === 0) {
    throw new WorkspaceError(`git merge ${source} failed in the worktree: ${merge.stderr.trim() || merge.stdout.trim() || 'unknown error'}`);
  }
  return { status: 'conflicts', conflicts, mergeSha: null };
}

/** Finalize an in-progress merge after the agent resolved every unmerged
 *  path. Tolerates the agent committing itself (no MERGE_HEAD left): the
 *  current tip then stands as the merge result. Returns HEAD's sha. */
export async function completeWorktreeMerge(runner: GitRunner, worktreePath: string): Promise<string> {
  const inProgress = await runner(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd: worktreePath });
  if (inProgress.code === 0) {
    await mustGit(runner, ['commit', '--no-edit'], { cwd: worktreePath });
  }
  return (await mustGit(runner, ['rev-parse', 'HEAD'], { cwd: worktreePath })).trim();
}

/** Stage and commit everything the agent left in the worktree. Refuses a
 *  worktree with unresolved merge conflicts (their markers would land on
 *  the base branch). */
export async function commitJobChanges(runner: GitRunner, input: { path: string; message: string }): Promise<JobCommit> {
  const unmerged = await listUnmergedPaths(runner, input.path);
  if (unmerged.length > 0) throw new ConflictError(unmerged);
  await mustGit(runner, ['add', '-A', '--', '.'], { cwd: input.path });
  const diff = await runner(['diff', '--cached', '--quiet'], { cwd: input.path });
  if (diff.code === 0) return { committed: false, sha: null };
  await mustGit(runner, ['commit', '-m', input.message], { cwd: input.path, env: EXECUTOR_AUTHOR });
  const sha = (await mustGit(runner, ['rev-parse', 'HEAD'], { cwd: input.path })).trim();
  return { committed: true, sha };
}

/** True when the checkout has tracked (staged or unstaged) changes. */
async function hasTrackedChanges(runner: GitRunner, repoRoot: string): Promise<boolean> {
  const out = await mustGit(runner, ['status', '--porcelain'], { cwd: repoRoot });
  return out.split('\n').some((line) => line.trim() && !line.startsWith('??'));
}

export interface CheckpointResult {
  checkpointed: boolean;
  sha: string | null;
  skipped?: string;
}

/**
 * Advance the base branch to a commit of the checkout's current working
 * tree, so a merge on top of it can never discard in-flight work. No-op
 * when the checkout is clean, when its content already matches the ref, or
 * when it sits on another branch (the tree-less merge below then cannot
 * disturb it anyway).
 */
async function checkpointWorkingTree(
  runner: GitRunner,
  input: { repoRoot: string; baseRef: string },
): Promise<CheckpointResult> {
  const headBranch = (await mustGit(runner, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: input.repoRoot })).trim();
  if (headBranch !== input.baseRef) {
    return { checkpointed: false, sha: null, skipped: `checkout is on '${headBranch}', not '${input.baseRef}'` };
  }
  if (!(await hasTrackedChanges(runner, input.repoRoot))) return { checkpointed: false, sha: null };
  const snap = await createSnapshotCommit(runner, input.repoRoot);
  const tip = (await mustGit(runner, ['rev-parse', input.baseRef], { cwd: input.repoRoot })).trim();
  const snapTree = (await mustGit(runner, ['rev-parse', `${snap}^{tree}`], { cwd: input.repoRoot })).trim();
  const tipTree = (await mustGit(runner, ['rev-parse', `${input.baseRef}^{tree}`], { cwd: input.repoRoot })).trim();
  if (snapTree === tipTree) return { checkpointed: false, sha: null };
  await mustGit(runner, ['update-ref', `refs/heads/${input.baseRef}`, snap, tip], { cwd: input.repoRoot });
  return { checkpointed: true, sha: snap };
}

export interface MergeResult {
  ok: boolean;
  /** False when the branch had nothing left to merge. */
  merged: boolean;
  mergeSha?: string;
  /** The branch tip, when it was already contained in the base. */
  branchSha?: string;
  baseSha?: string;
  checkpoint?: CheckpointResult;
  conflicts?: string[];
  error?: string;
}

function parseConflicts(output: string): string[] {
  const paths = new Set<string>();
  for (const line of output.split('\n').slice(1)) {
    const match = /^\d{6} [0-9a-f]+ \d+\t(.+)$/.exec(line);
    if (match) paths.add(match[1]!);
  }
  return [...paths];
}

/**
 * Merge a job branch into the base branch without touching any working
 * tree. See the module doc for the checkpoint / merge-tree / commit-tree /
 * CAS update-ref sequence. The three-way base is the branch's current
 * common ancestor with the base branch, re-resolved on every attempt
 * (falling back to the recorded base when no ancestor exists) — NOT the
 * recorded base itself, which goes stale the moment the branch merges the
 * base branch into itself to resolve conflicts and would then report the
 * same conflicts on every future attempt.
 */
export async function mergeJobBranch(
  runner: GitRunner,
  input: { repoRoot: string; branch: string; baseSha: string; baseRef: string; message: string },
): Promise<MergeResult> {
  let checkpoint: CheckpointResult;
  try {
    checkpoint = await checkpointWorkingTree(runner, { repoRoot: input.repoRoot, baseRef: input.baseRef });
  } catch (error) {
    return { ok: false, merged: false, error: error instanceof Error ? error.message : String(error) };
  }
  const branchSha = (await runner(['rev-parse', '--verify', '--quiet', `${input.branch}^{commit}`], { cwd: input.repoRoot }));
  if (branchSha.code !== 0) {
    return { ok: false, merged: false, checkpoint, error: `branch ${input.branch} no longer exists` };
  }
  const theirs = branchSha.stdout.trim();
  for (let attempt = 0; attempt < 2; attempt++) {
    const ours = (await mustGit(runner, ['rev-parse', input.baseRef], { cwd: input.repoRoot })).trim();
    if (ours === theirs) return { ok: true, merged: false, checkpoint, baseSha: ours, branchSha: theirs };
    // Branch already contained in the base: nothing to merge.
    const contained = await runner(['merge-base', '--is-ancestor', theirs, ours], { cwd: input.repoRoot });
    if (contained.code === 0) return { ok: true, merged: false, checkpoint, baseSha: ours, branchSha: theirs };
    const common = await runner(['merge-base', input.baseRef, input.branch], { cwd: input.repoRoot });
    const mergeBase = common.code === 0 && common.stdout.trim() ? common.stdout.trim() : input.baseSha;
    const merge = await runner(
      ['merge-tree', '--write-tree', `--merge-base=${mergeBase}`, input.baseRef, input.branch],
      { cwd: input.repoRoot },
    );
    if (merge.code === 1) {
      return { ok: false, merged: false, checkpoint, conflicts: parseConflicts(merge.stdout) };
    }
    if (merge.code !== 0) {
      return { ok: false, merged: false, checkpoint, error: (merge.stderr || merge.stdout).trim().slice(0, 400) };
    }
    const tree = merge.stdout.split('\n')[0]!.trim();
    try {
      const mergeSha = (await mustGit(runner,
        ['commit-tree', tree, '-p', ours, '-p', theirs, '-m', input.message],
        { cwd: input.repoRoot, env: EXECUTOR_AUTHOR })).trim();
      const updated = await runner(['update-ref', `refs/heads/${input.baseRef}`, mergeSha, ours], { cwd: input.repoRoot });
      if (updated.code === 0) return { ok: true, merged: true, mergeSha, baseSha: ours, checkpoint };
    } catch (error) {
      return { ok: false, merged: false, checkpoint, error: error instanceof Error ? error.message : String(error) };
    }
    // CAS failed: the base moved concurrently — retry against the new tip.
  }
  return { ok: false, merged: false, checkpoint, error: 'the base branch moved during the merge; retry' };
}

export interface SyncResult {
  synced: boolean;
  reason?: string;
}

/** Materialize the base branch in the checkout after a merge — only safe
 *  (and only meaningful) when the checkout sits on the base branch. */
export async function syncCheckout(runner: GitRunner, input: { repoRoot: string; baseRef: string }): Promise<SyncResult> {
  const headBranch = (await mustGit(runner, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: input.repoRoot })).trim();
  if (headBranch !== input.baseRef) {
    return { synced: false, reason: `the checkout is on '${headBranch}', not '${input.baseRef}'` };
  }
  await mustGit(runner, ['reset', '--hard', input.baseRef], { cwd: input.repoRoot });
  return { synced: true };
}

export interface DeployResult {
  code: number;
  output: string;
}

/** Run the deploy command in the repo checkout. 30-minute ceiling. */
export async function runDeployCommand(command: string, repoRoot: string): Promise<DeployResult> {
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
      cwd: repoRoot,
      timeout: 1_800_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    return { code: 0, output: `${stdout}\n${stderr}`.trim().slice(-4000) };
  } catch (error) {
    const err = error as { code?: unknown; stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`.trim().slice(-4000);
    return { code: typeof err.code === 'number' ? err.code : 1, output: err.killed ? `${output}\n(command timed out)`.trim() : output };
  }
}

/** Remove a job's worktree and its branch (best effort — used after merges
 *  and setup failures). */
export async function removeJobWorkspace(
  runner: GitRunner,
  input: { repoRoot: string; path: string; branch: string; deleteBranch?: boolean },
): Promise<void> {
  await runner(['worktree', 'remove', '--force', input.path], { cwd: input.repoRoot });
  if (input.deleteBranch !== false) {
    await runner(['branch', '-D', input.branch], { cwd: input.repoRoot });
  }
  await runner(['worktree', 'prune'], { cwd: input.repoRoot });
}

export interface JobLogCommit {
  sha: string;
  subject: string;
  at: string;
}

export type JobLog =
  | { gone: true }
  | { gone?: false; branch: string; commits: JobLogCommit[]; status: string; error?: string };

/**
 * A job's work for the log endpoint: the commits on its branch
 * (`base..HEAD` — the range excludes the snapshot the worktree was cut
 * from) plus its uncommitted porcelain status. Everything runs INSIDE the
 * worktree; `{gone: true}` once the directory is removed. Git failures
 * surface in `error` rather than throwing — this feeds an inspection view,
 * not a control flow.
 */
export async function readJobLog(
  runner: GitRunner,
  input: { worktreePath: string; branch: string; baseSha?: string | null; maxCommits?: number },
): Promise<JobLog> {
  if (!existsSync(input.worktreePath)) return { gone: true };
  const maxCommits = Math.max(1, input.maxCommits ?? 50);
  const range = input.baseSha ? `${input.baseSha}..HEAD` : 'HEAD';
  const result: JobLog = { branch: input.branch, commits: [], status: '' };
  const log = await runner(
    ['log', '--format=%H%x1f%aI%x1f%s', '-n', String(maxCommits), range],
    { cwd: input.worktreePath },
  );
  if (log.code === 0) {
    result.commits = log.stdout.split('\n').flatMap((line) => {
      if (!line) return [];
      const [sha, at, subject] = line.split('\x1f');
      if (!sha || !at || subject === undefined) return [];
      return [{ sha, at, subject }];
    });
  } else {
    result.error = (log.stderr || log.stdout).trim();
  }
  const status = await runner(['status', '--porcelain'], { cwd: input.worktreePath });
  if (status.code === 0) result.status = status.stdout.replace(/\n$/, '');
  else result.error ??= (status.stderr || status.stdout).trim();
  return result;
}

/* ── Attachments: the git-excluded `builder-input/` directory ─────────── */

/** Where materialized attachments land inside a job's worktree. */
export const ATTACHMENTS_DIR = 'builder-input';

/** Make an uploaded filename safe to write inside the attachments
 *  directory: strip any path components (traversal), drop control
 *  characters and leading dots, cap the length (keeping the extension),
 *  and uniquify against names already taken in this batch. Pure. */
export function sanitizeAttachmentName(raw: string, taken: ReadonlySet<string> = new Set()): string {
  let name = String(raw ?? '').split(/[/\\]/).pop() ?? '';
  // Control characters (including NUL) and reserved shell characters become
  // underscores; leading dots are dropped so nothing hides from globs.
  name = name.replace(/[\x00-\x1f\x7f`$<>|:*?"']/g, '_').replace(/^\.+/, '').trim();
  if (!name) name = 'attachment';
  if (name.length > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
    name = `${name.slice(0, 120 - ext.length)}${ext}`;
  }
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Human file size for the prompt listing (pure). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** One materialized attachment: the path exactly as the prompt should name
 *  it (worktree-relative). */
export interface MaterializedAttachment {
  name: string;
  path: string;
  mimeType: string;
  byteSize: number;
}

/** One decoded attachment buffer, ready to write. */
export interface AttachmentFile {
  name: string;
  mimeType: string;
  data: Buffer;
}

/**
 * Write the attachments into `<worktree>/builder-input/` and make git
 * ignore them: the directory is added to the worktree's git exclude —
 * BEFORE any file is written, and the whole call fails when the exclude
 * cannot be written. An unexcluded attachment could be committed, merged
 * or deployed, which is exactly what must never happen (user files are
 * private).
 *
 * Re-materialization is idempotent: files are overwritten and the exclude
 * line is only appended when missing.
 */
export async function materializeJobAttachments(
  runner: GitRunner,
  worktreePath: string,
  attachments: readonly AttachmentFile[],
): Promise<{ dir: string; files: MaterializedAttachment[] }> {
  if (!attachments.length) return { dir: '', files: [] };
  const dir = join(worktreePath, ATTACHMENTS_DIR);
  const stat = (path: string) => {
    try { return lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const directory = stat(dir);
  if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) {
    throw new WorkspaceError('Unsafe attachment directory (must not be a symlink)', dir);
  }
  // Git excludes never hide tracked files. Reject the whole private namespace
  // before writing even the first attachment, including on cached stage reuse.
  const tracked = await mustGit(runner, ['ls-files', '-z', '--', ATTACHMENTS_DIR], { cwd: worktreePath });
  if (tracked) throw new WorkspaceError('Attachment directory contains tracked paths', ATTACHMENTS_DIR);
  const taken = new Set<string>();
  const files: MaterializedAttachment[] = [];
  for (const attachment of attachments) {
    const name = sanitizeAttachmentName(attachment.name, taken);
    taken.add(name);
    const existing = stat(join(dir, name));
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw new WorkspaceError('Unsafe attachment destination (must not be a symlink)', name);
    }
    if (existing && existing.nlink !== 1) {
      throw new WorkspaceError('Unsafe attachment destination (hardlink / multiple links)', name);
    }
    files.push({
      name,
      path: `${ATTACHMENTS_DIR}/${name}`,
      mimeType: attachment.mimeType,
      byteSize: attachment.data.length,
    });
  }
  // Preflight the entire batch and persist exclusion BEFORE sensitive writes.
  await excludeDirectory(runner, worktreePath, ATTACHMENTS_DIR);
  const temporary = files.map(() => `${ATTACHMENTS_DIR}/.attachment-${randomUUID()}.tmp`);
  // info/exclude is lower priority than .gitignore, and an existing exclude
  // line can itself be followed by a negation. Verify every final AND staging
  // path, including on reuse, rather than trusting that an exclude was added.
  await verifyAttachmentsIgnored(runner, worktreePath, [...files.map((file) => file.path), ...temporary]);
  await mkdir(dir, { recursive: true });
  for (const [index, attachment] of attachments.entries()) {
    const staging = join(worktreePath, temporary[index]!);
    // Never open/truncate a pre-existing destination inode. An exclusive new
    // inode followed by same-directory rename cannot overwrite the contents of
    // an outside hardlink, even if that link appeared after batch preflight.
    const handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await handle.writeFile(attachment.data); }
      finally { await handle.close(); }
      await rename(staging, join(dir, files[index]!.name));
    } finally {
      await unlink(staging).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  return { dir: ATTACHMENTS_DIR, files };
}

/** Verbose NUL records distinguish positive matches from explicit negations;
 * exit 0 alone only proves that SOME path matched, not that all are ignored. */
async function verifyAttachmentsIgnored(runner: GitRunner, worktreePath: string, paths: readonly string[]): Promise<void> {
  const result = await runner(['check-ignore', '--verbose', '--non-matching', '-z', '--stdin'], {
    cwd: worktreePath, input: `${paths.join('\0')}\0`,
  });
  if (result.code !== 0 && result.code !== 1) {
    throw new WorkspaceError('Could not verify attachment git exclusions', result.stderr.trim() || 'git failed');
  }
  const records = result.stdout.split('\0');
  if (records.pop() !== '' || records.length !== paths.length * 4) {
    throw new WorkspaceError('Could not verify attachment git exclusions', 'incomplete git check-ignore response');
  }
  for (const [index, path] of paths.entries()) {
    const [source, , pattern, matched] = records.slice(index * 4, index * 4 + 4);
    if (matched !== path || !source || !pattern || pattern.startsWith('!')) {
      throw new WorkspaceError('Attachment path is not git-ignored', path);
    }
  }
}

/**
 * Add `dir/` to the worktree's git exclude so `git add -A`, the safety-net
 * commit and `git status` all ignore it. Throws when git cannot resolve the
 * exclude path or the file cannot be written — callers must treat that as
 * a launch failure.
 *
 * The path is resolved with `git rev-parse --git-path` (the authoritative
 * location): for a linked worktree that is the COMMON git dir, so the line
 * also covers the repo's main checkout and sibling worktrees. That is fine
 * — exclude patterns only affect UNTRACKED files. Materialization separately
 * rejects tracked `builder-input` paths before writing private attachments.
 */
async function excludeDirectory(runner: GitRunner, worktreePath: string, dir: string): Promise<void> {
  const resolved = await runner(['rev-parse', '--git-path', 'info/exclude'], { cwd: worktreePath });
  if (resolved.code !== 0 || !resolved.stdout.trim()) {
    throw new WorkspaceError(`Could not resolve the worktree's git exclude file: ${resolved.stderr.trim() || 'git failed'}`);
  }
  const excludePath = resolve(worktreePath, resolved.stdout.trim());
  await mkdir(dirname(excludePath), { recursive: true });
  const existing = existsSync(excludePath) ? await readFile(excludePath, 'utf8') : '';
  if (existing.split('\n').some((line) => line.trim() === `${dir}/`)) return;
  await appendFile(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}${dir}/\n`);
}

/* ── Native agent personas (hub ≥ nativeAgents capability) ─────────────── */

/** The persona payload the hub ships in `spec.agent`: pre-rendered, so this
 *  tree never imports hub rendering code (boundary lint) — it just writes
 *  the strings into the job's worktree. */
export interface JobAgentMaterialization {
  /** Display name (events/UI only). */
  name: string;
  /** The OpenCode project-agent id the session pins (`nexus-<slug>-<id8>`). */
  opencodeAgent: string;
  /** Full `.opencode/agents/<opencodeAgent>.md` content. */
  markdown: string;
  /** Full opencode.json MCP fragment, or null when the persona has no servers. */
  mcp: Record<string, unknown> | null;
  skills?: JobSkillMaterialization[];
}

export interface JobSkillMaterialization {
  id: string;
  files: { path: string; dataBase64: string }[];
  sha256: string;
}

/** Validate both wire contents and the digest before touching a worktree. */
export function validateJobSkills(value: unknown): JobSkillMaterialization[] {
  if (!Array.isArray(value) || value.length > 20) throw new WorkspaceError('Invalid job skills count');
  let total = 0;
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new WorkspaceError('Invalid job skill');
    const skill = entry as Record<string, unknown>;
    if (typeof skill.id !== 'string' || skill.id.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id) || ids.has(skill.id)) throw new WorkspaceError('Invalid or duplicate skill id');
    ids.add(skill.id);
    if (!Array.isArray(skill.files) || !skill.files.length || skill.files.length > 50) throw new WorkspaceError('Invalid skill files');
    const paths = new Set<string>();
    const hash = createHash('sha256');
    const files = skill.files.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new WorkspaceError('Invalid skill file');
      const file = item as Record<string, unknown>;
      if (typeof file.path !== 'string' || file.path.length > 300 || file.path.split('/').length > 3 || !file.path.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part) && part !== '..') || paths.has(file.path)) throw new WorkspaceError('Invalid or duplicate skill path');
      paths.add(file.path);
      if (typeof file.dataBase64 !== 'string' || file.dataBase64.length > 1_400_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.dataBase64)) throw new WorkspaceError('Invalid skill file data');
      const bytes = Buffer.from(file.dataBase64, 'base64');
      if (bytes.length > (file.path === 'SKILL.md' ? 100_000 : 1024 * 1024) || (total += bytes.length) > 4 * 1024 * 1024) throw new WorkspaceError('Skill payload exceeds size limit');
      hash.update(`${file.path}\0${bytes.length}\0`);
      hash.update(bytes);
      return { path: file.path, dataBase64: file.dataBase64 };
    });
    if (!paths.has('SKILL.md')) throw new WorkspaceError('Skill missing SKILL.md');
    if (typeof skill.sha256 !== 'string' || hash.digest('hex') !== skill.sha256) throw new WorkspaceError('Skill digest mismatch');
    return { id: skill.id, files, sha256: skill.sha256 };
  });
}

export async function materializeJobSkills(runner: GitRunner, worktreePath: string, skills: readonly JobSkillMaterialization[]): Promise<void> {
  // Stored jobs can be retried after a restart: revalidate before applying.
  validateJobSkills(skills);
  for (const skill of skills) {
    const rel = `.opencode/skills/${skill.id}`;
    const dir = join(worktreePath, rel);
    const root = join(worktreePath, '.opencode');
    const skillsDir = join(root, 'skills');
    for (const parent of [root, skillsDir, dir]) {
      const info = existsSync(parent) ? lstatSync(parent) : null;
      if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new WorkspaceError(`Unsafe skill destination: ${parent}`);
    }
    // Exclude new files, and hide tracked replacements and stale tracked files
    // from any safety-net `git add -A` or commit in this worktree only.
    await excludePatterns(runner, worktreePath, [`/${rel}/`]);
    const tracked = await mustGit(runner, ['ls-files', '-z', '--', rel], { cwd: worktreePath });
    for (const path of tracked.split('\0').filter(Boolean)) {
      await mustGit(runner, ['update-index', '--skip-worktree', '--', path], { cwd: worktreePath });
    }
    // Replacing the whole directory prevents stale reference files from the
    // repository or a previous job snapshot from being offered to OpenCode.
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    await mkdir(dir, { recursive: true });
    for (const file of skill.files) {
      const target = join(dir, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.dataBase64, 'base64'));
    }
  }
}

/** Append the missing EXACT patterns to the worktree's git exclude
 *  (idempotent; anchored patterns only match each checkout's top level).
 *  Mirrored from the hub's ensureGitExcluded. */
async function excludePatterns(runner: GitRunner, worktreePath: string, patterns: readonly string[]): Promise<void> {
  const resolved = await runner(['rev-parse', '--git-path', 'info/exclude'], { cwd: worktreePath });
  if (resolved.code !== 0 || !resolved.stdout.trim()) {
    throw new WorkspaceError(`Could not resolve the worktree's git exclude file: ${resolved.stderr.trim() || 'git failed'}`);
  }
  const excludePath = resolve(worktreePath, resolved.stdout.trim());
  await mkdir(dirname(excludePath), { recursive: true });
  const existing = existsSync(excludePath) ? await readFile(excludePath, 'utf8') : '';
  const lines = new Set(existing.split('\n').map((line) => line.trim()));
  const missing = patterns.filter((pattern) => !lines.has(pattern));
  if (!missing.length) return;
  await appendFile(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}${missing.join('\n')}\n`);
}

/**
 * Native persona tier for remote jobs: write
 * `<worktree>/.opencode/agents/<name>.md` (+ its MCP fragment) so the job's
 * session can pin the persona as a real OpenCode project agent — the run
 * then gets the persona's curated skills list and MCP servers exactly like
 * a local execution (previously remote runs were prompt-tier only and lost
 * both). The git-excluded exclude lands BEFORE any file (a failing exclude
 * write fails the launch rather than risk an unexcluded file reaching the
 * safety-net commit). The MCP fragment merges into an existing opencode.json
 * (parse failure fails the launch — never clobber); the model-policy
 * registration that runs afterwards merges its policies on top of it.
 * Idempotent — retries re-materialize on the re-attached worktree.
 */
/** Generated launch configuration is execution state, never branch content.
 * Ignore new files; protect already-tracked files in this worktree's index. */
export async function protectJobConfig(runner: GitRunner, worktreePath: string, files: readonly string[]): Promise<void> {
  await excludePatterns(runner, worktreePath, files.map((file) => `/${file}`));
  for (const file of files) {
    const tracked = await runner(['ls-files', '--error-unmatch', '--', file], { cwd: worktreePath });
    if (tracked.code !== 0) continue;
    const protectedFile = await runner(['update-index', '--skip-worktree', '--', file], { cwd: worktreePath });
    if (protectedFile.code !== 0) throw new WorkspaceError(`Cannot protect generated configuration ${file}: ${protectedFile.stderr}`);
  }
}

export async function materializeJobAgent(
  runner: GitRunner,
  worktreePath: string,
  agent: JobAgentMaterialization,
): Promise<{ opencodeAgent: string; mcp: 'none' | 'written' }> {
  await excludePatterns(runner, worktreePath, agent.mcp ? ['/.opencode/agents/', '/opencode.json'] : ['/.opencode/agents/']);
  await protectJobConfig(runner, worktreePath, [`.opencode/agents/${agent.opencodeAgent}.md`, ...(agent.mcp ? ['opencode.json'] : [])]);
  const dir = join(worktreePath, '.opencode', 'agents');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${agent.opencodeAgent}.md`), agent.markdown, 'utf8');
  let mcp: 'none' | 'written' = 'none';
  if (agent.mcp) {
    const file = join(worktreePath, 'opencode.json');
    let existing: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new WorkspaceError(`The workspace's existing opencode.json is not valid JSON — the agent's MCP config cannot be merged into it (${(error as Error).message}).`);
      }
    }
    await writeFile(file, `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...existing, mcp: agent.mcp.mcp ?? agent.mcp }, null, 2)}\n`, 'utf8');
    mcp = 'written';
  }
  return { opencodeAgent: agent.opencodeAgent, mcp };
}

/* ── Verification environment + runner ──────────────────────────────────
 *
 * A verification command (`npm test`) must reproduce what a developer in a
 * fresh shell gets — not inherit the executor's configuration. The
 * executor loads `.env` into its process, and that config must not leak
 * into worktree verifications (the hub's 2026-10-02 incident: a leaked
 * `MIN_PASSWORD_LENGTH=5` flipped a password test). Rule: ALLOWLIST — only
 * shell basics survive; no app configuration, no secrets.
 */

const JOB_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR'];

/** Only what a fresh login shell provides — never the executor's config. */
export function jobEnv(processEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of JOB_ENV_KEYS) {
    const value = processEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface CommandResult {
  code: number;
  /** Combined stdout+stderr, tail-capped at 8 000 chars. */
  output: string;
}

const OUTPUT_TAIL_LIMIT = 8_000;

// The IPC pipe is an owner-liveness fence: even SIGKILL of the executor
// closes it. The supervisor kills its own process group on disconnect,
// preventing an orphan verifier from writing into a recovered attempt.
const COMMAND_SUPERVISOR = `
const { spawn } = require('node:child_process');
process.on('disconnect', () => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} });
const child = spawn('sh', ['-c', process.argv[1]], { stdio: ['ignore', 'inherit', 'inherit'] });
child.on('error', (error) => { console.error(error.message); process.exit(1); });
child.on('exit', (code) => process.exit(code ?? 1));
`;

/** Run one verification command (`sh -c …`) with the allowlist env,
 * an owner-supervised process group and a bounded output tail. */
export async function runJobCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<CommandResult> {
  if (signal?.aborted) return { code: 1, output: 'Command cancelled.' };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', COMMAND_SUPERVISOR, '--', command], {
      cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let output = '';
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-OUTPUT_TAIL_LIMIT); };
    child.stdout!.on('data', capture);
    child.stderr!.on('data', capture);
    const stop = () => {
      // Kill the entire group, including grandchildren holding output pipes.
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
    };
    const timeout = setTimeout(stop, 3_600_000);
    signal?.addEventListener('abort', stop, { once: true });
    const finish = (code: number, error = '') => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', stop);
      resolve({ code, output: (output + error).trim().slice(-OUTPUT_TAIL_LIMIT) });
    };
    child.on('error', (error) => finish(1, error.message));
    // A shell may leave background descendants holding the output pipes.
    child.on('exit', stop);
    child.on('close', (code) => finish(code ?? 1));
  });
}
