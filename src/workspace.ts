import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
    const { stdout, stderr } = await execFileAsync('git', args as string[], {
      cwd: options?.cwd ?? undefined,
      timeout: options?.timeoutMs ?? 120_000,
      maxBuffer: 16 * 1024 * 1024,
      env: mergedEnv(options?.env),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: unknown; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? '',
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

/** Remove a job's worktree and its branch (best effort). Called ONLY from
 *  the hub-invoked merge flow — the engine never deletes a workspace on
 *  its own; failed attempts keep theirs for resume and inspection. */
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
  await mkdir(dir, { recursive: true });
  await excludeDirectory(runner, worktreePath, ATTACHMENTS_DIR);
  const taken = new Set<string>();
  const files: MaterializedAttachment[] = [];
  for (const attachment of attachments) {
    const name = sanitizeAttachmentName(attachment.name, taken);
    taken.add(name);
    await writeFile(join(dir, name), attachment.data);
    files.push({
      name,
      path: `${ATTACHMENTS_DIR}/${name}`,
      mimeType: attachment.mimeType,
      byteSize: attachment.data.length,
    });
  }
  return { dir: ATTACHMENTS_DIR, files };
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
 * — exclude patterns only affect UNTRACKED files, and no checkout carries a
 * tracked top-level `builder-input/`.
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

/** Run one verification command (`sh -c …`) in a directory with the
 *  allowlist env. 512 KB output ceiling; the TAIL is kept for reports. */
export async function runJobCommand(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
      cwd,
      env,
      timeout: 3_600_000,
      maxBuffer: 512 * 1024,
    });
    return { code: 0, output: `${stdout}\n${stderr}`.trim().slice(-OUTPUT_TAIL_LIMIT) };
  } catch (error) {
    const err = error as { code?: unknown; stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const output = `${err.stdout ?? ''}\n${err.stderr ?? ''}\n${err.message ?? ''}`.trim().slice(-OUTPUT_TAIL_LIMIT);
    return { code: typeof err.code === 'number' ? err.code : 1, output: err.killed ? `${output}\n(command timed out)`.trim() : output };
  }
}
