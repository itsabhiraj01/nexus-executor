import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { ExecutorConfig } from './config.js';
import { createPool, runModuleMigrations, defaultMigrationsDir } from './db.js';
import {
  EVENT,
  JobEngine,
  getJobByHubId,
  jobShortId,
  repairPrompt,
  stallFailureReason,
  type JobRow,
  type JobSpecInput,
} from './engine.js';
import {
  createOpenCodeClient,
  type ModelRef,
  type OpenCodeClient,
  type OpenCodeMessage,
} from './opencode.js';
import { countEvents, eventTypes, makeRepo, makeStubClient, testConfig } from './testkit.js';
import { commitJobChanges, execGit } from './workspace.js';

let pool: Pool;
let root: string;
let repoRoot: string;
let config: ExecutorConfig;

beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL!);
  await pool.query('DROP SCHEMA IF EXISTS executor CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS platform CASCADE');
  await runModuleMigrations(pool, 'executor', 'executor', defaultMigrationsDir());
  root = mkdtempSync(join(tmpdir(), 'nexus-exec-engine-'));
  repoRoot = await makeRepo(join(root, 'repo'));
  // Several jobs are alive per describe; 4 slots keep a mid-test failure
  // from starving the rest (worker.test.ts owns the capacity assertions).
  config = testConfig(join(root, 'workspaces'), { maxParallelJobs: 4 });
});

afterAll(async () => {
  await pool.end();
  // Clean up worktrees/branches before removing the temp tree.
  if (existsSync(repoRoot)) {
    await execGit(['worktree', 'prune'], { cwd: repoRoot });
  }
  rmSync(root, { recursive: true, force: true });
});

interface Ctx {
  engine: JobEngine;
  client: OpenCodeClient;
  stub: ReturnType<typeof makeStubClient>['state'];
}

function makeEngine(overrides: Partial<ExecutorConfig> = {}): Ctx {
  const stubbed = makeStubClient();
  const engine = new JobEngine({
    pool,
    config: { ...config, ...overrides },
    client: stubbed.client,
    git: execGit,
  });
  return { engine, client: stubbed.client, stub: stubbed.state };
}

function spec(overrides: Partial<JobSpecInput> = {}): JobSpecInput {
  return {
    jobId: `job-${Math.random().toString(36).slice(2, 10)}`,
    title: 'Test job',
    prompt: 'Do the thing.',
    verificationCommand: '',
    project: { name: 'repo', localPath: repoRoot },
    models: [],
    attachments: [],
    ...overrides,
  };
}

function done(id: string, text: string, created: number): OpenCodeMessage {
  return { id, type: 'assistant', finish: 'stop', content: [{ type: 'text', text }], time: { created } };
}

async function runningJob(ctx: Ctx, input: JobSpecInput): Promise<JobRow> {
  const { job, created } = await ctx.engine.createJob(input);
  expect(created).toBe(true);
  const launched = (await getJobByHubId(pool, input.jobId))!;
  expect(launched.status).toBe('running');
  expect(launched.opencodeSessionId).toBeTruthy();
  void job;
  return launched;
}

describe('launch', () => {
  it('cuts a worktree, creates the session in it, and sends the composed prompt', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-launch-1', title: 'Launch me', models: ['litellm/open-large'] }));
    const short = jobShortId('job-launch-1');
    expect(job.branch).toBe(`job-${short}`);
    expect(job.worktreePath).toContain(`job-${short}`);
    expect(existsSync(job.worktreePath)).toBe(true);
    expect(ctx.stub.sessions).toHaveLength(1);
    expect(ctx.stub.sessions[0]).toMatchObject({
      title: 'Launch me',
      directory: job.worktreePath,
      model: { providerID: 'litellm', modelID: 'open-large' } satisfies ModelRef,
    });
    expect(job.model).toBe('litellm/open-large');
    expect(ctx.stub.prompts).toHaveLength(1);
    expect(ctx.stub.prompts[0]!.text).toContain('Do the thing.');

    const types = await eventTypes(pool, job.id);
    expect(types).toEqual([EVENT.WORKTREE_CREATED, EVENT.SESSION_CREATED, EVENT.PROMPT_SENT, EVENT.EXECUTION_STATUS_CHANGED]);

    const baseRef = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot });
    const branches = await execGit(['branch', '--list', job.branch], { cwd: repoRoot });
    expect(branches.stdout).toContain(job.branch);
    void baseRef;
    await ctx.engine.cancel('job-launch-1'); // free the single slot for later tests
  });

  it('fails cleanly when the project points nowhere (session_setup_failed)', async () => {
    const ctx = makeEngine();
    const { job } = await ctx.engine.createJob(spec({ jobId: 'job-fail-setup', prompt: 'x', project: null }));
    const row = (await getJobByHubId(pool, 'job-fail-setup'))!;
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('session_setup_failed');
    expect(row.failureReason).toContain('localPath');
    void job;
  });

  it('materializes attachments into a git-excluded builder-input/ and lists them in the prompt', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({
      jobId: 'job-attach',
      attachments: [
        { name: '../notes.md', mimeType: 'text/markdown', dataBase64: Buffer.from('# Notes\nhello').toString('base64') },
        { name: 'data.csv', mimeType: 'text/csv', dataBase64: Buffer.from('a,b\n1,2').toString('base64') },
      ],
    }));
    const inputDir = join(job.worktreePath, 'builder-input');
    expect(existsSync(join(inputDir, 'notes.md'))).toBe(true);
    expect(readFileSync(join(inputDir, 'data.csv'), 'utf8')).toBe('a,b\n1,2');
    expect(ctx.stub.prompts[0]!.text).toContain('### Attached files');
    expect(ctx.stub.prompts[0]!.text).toContain('builder-input/notes.md');

    // The exclude invariant: `git add -A` stages NOTHING from builder-input.
    await execGit(['add', '-A', '--', '.'], { cwd: job.worktreePath });
    const status = await execGit(['status', '--porcelain'], { cwd: job.worktreePath });
    expect(status.stdout.trim()).toBe('');
    const listed = await execGit(['ls-files'], { cwd: job.worktreePath });
    expect(listed.stdout).not.toContain('builder-input');

    // Turn-completion safety net also sweeps nothing.
    ctx.stub.messages[job.opencodeSessionId!] = [done('m-done', 'Read the files.', Date.now())];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-attach'))!);
    const log = await execGit(['log', '--format=%s'], { cwd: job.worktreePath });
    expect(log.stdout).not.toContain('builder-input');
    await ctx.engine.cancel('job-attach');
  });

  it('is idempotent on hub jobId', async () => {
    const ctx = makeEngine();
    const first = await ctx.engine.createJob(spec({ jobId: 'job-idem' }));
    const second = await ctx.engine.createJob(spec({ jobId: 'job-idem', prompt: 'changed' }));
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.prompt).toBe('Do the thing.');
    await ctx.engine.cancel('job-idem');
  });
});

describe('poll lifecycle', () => {
  it('folds events and succeeds a completed turn when there is no verification command', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-poll-1' }));
    const now = Date.now();
    ctx.stub.messages[job.opencodeSessionId!] = [
      done('m1', 'All implemented.', now),
      { id: 'm0', type: 'idle', outcome: 'succeeded', time: { created: now - 10 } },
    ];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-poll-1'))!);
    await ctx.engine.drain();

    const row = (await getJobByHubId(pool, 'job-poll-1'))!;
    expect(row.status).toBe('succeeded');
    expect(row.summary).toBe('All implemented.');
    const types = await eventTypes(pool, row.id);
    expect(types).toContain('AGENT_MESSAGE');
    expect(types).toContain('AGENT_IDLE');
    expect(types.indexOf(EVENT.EXECUTION_SUCCEEDED)).toBeGreaterThan(types.indexOf(EVENT.EXECUTION_STATUS_CHANGED));

    // A second poll folds nothing new.
    const before = await countEvents(pool, row.id);
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-poll-1'))!);
    expect(await countEvents(pool, row.id)).toBe(before);
  });

  it('parks a question, resumes on a hub message into the SAME session, then succeeds', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-ask' }));
    const sessionId = job.opencodeSessionId!;
    const now = Date.now();
    ctx.stub.messages[sessionId] = [done('m-ask', 'Should I use TypeScript or Go?', now)];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-ask'))!);

    let row = (await getJobByHubId(pool, 'job-ask'))!;
    expect(row.status).toBe('waiting_for_user');
    let types = await eventTypes(pool, row.id);
    expect(types).toContain(EVENT.AGENT_ASKED_USER);

    await ctx.engine.sendMessage('job-ask', 'TypeScript.');
    expect(ctx.stub.prompts).toHaveLength(2);
    expect(ctx.stub.prompts[1]).toMatchObject({ sessionId, text: 'TypeScript.' });
    row = (await getJobByHubId(pool, 'job-ask'))!;
    expect(row.status).toBe('running');
    types = await eventTypes(pool, row.id);
    expect(types).toContain(EVENT.HUB_MESSAGE);

    ctx.stub.messages[sessionId] = [
      done('m-done', 'Used TypeScript as requested.', now + 1000),
      ctx.stub.messages[sessionId]![0]!,
    ];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-ask'))!);
    await ctx.engine.drain();
    row = (await getJobByHubId(pool, 'job-ask'))!;
    expect(row.status).toBe('succeeded');
    expect(row.summary).toBe('Used TypeScript as requested.');
  });

  it('fails an errored turn with agent_error', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-err' }));
    ctx.stub.messages[job.opencodeSessionId!] = [{
      id: 'm-err', type: 'assistant', finish: 'error',
      error: { type: 'provider.auth', status: 401, message: 'No api key passed in.' },
      content: [], time: { created: Date.now() },
    }];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-err'))!);
    const row = (await getJobByHubId(pool, 'job-err'))!;
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('agent_error');
    expect(row.failureReason).toContain('No api key passed in.');
    expect(ctx.stub.interrupts).toContain(job.opencodeSessionId);
  });
});

describe('verification', () => {
  it('passes the command and succeeds with the agent summary', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-ver-ok', verificationCommand: 'true' }));
    ctx.stub.messages[job.opencodeSessionId!] = [done('m1', 'Verified work.', Date.now())];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-ver-ok'))!);
    await ctx.engine.drain();

    const row = (await getJobByHubId(pool, 'job-ver-ok'))!;
    expect(row.status).toBe('succeeded');
    expect(row.summary).toBe('Verified work.');
    expect(row.verificationAttemptCount).toBe(1);
    const types = await eventTypes(pool, row.id);
    expect(types).toEqual(expect.arrayContaining([EVENT.VERIFICATION_STARTED, EVENT.VERIFICATION_PASSED, EVENT.EXECUTION_SUCCEEDED]));
  });

  it('fails, repairs into the same session, and passes on the retry', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-ver-repair', verificationCommand: 'test -f ok.flag' }));
    const sessionId = job.opencodeSessionId!;
    const now = Date.now();
    ctx.stub.messages[sessionId] = [done('m1', 'First attempt done.', now)];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-ver-repair'))!);
    await ctx.engine.drain();

    let row = (await getJobByHubId(pool, 'job-ver-repair'))!;
    expect(row.status).toBe('running');
    expect(row.verificationAttemptCount).toBe(1);
    expect(ctx.stub.prompts).toHaveLength(2);
    expect(ctx.stub.prompts[1]!.text).toContain('The verification command `test -f ok.flag` failed with exit code 1.');
    expect(ctx.stub.prompts[1]!.text).toContain('Fix the problem in this session and make the verification command pass.');
    let types = await eventTypes(pool, row.id);
    expect(types).toEqual(expect.arrayContaining([EVENT.VERIFICATION_FAILED, EVENT.REPAIR_REQUESTED, EVENT.PROMPT_SENT]));

    // The agent "fixes" it; the next completed turn re-verifies.
    writeFileSync(join(job.worktreePath, 'ok.flag'), 'ok');
    ctx.stub.messages[sessionId] = [done('m2', 'Fixed — ok.flag in place.', now + 1000), ctx.stub.messages[sessionId]![0]!];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-ver-repair'))!);
    await ctx.engine.drain();

    row = (await getJobByHubId(pool, 'job-ver-repair'))!;
    expect(row.status).toBe('succeeded');
    expect(row.verificationAttemptCount).toBe(2);
    types = await eventTypes(pool, row.id);
    expect(types.filter((type) => type === EVENT.VERIFICATION_PASSED)).toHaveLength(1);
    expect(types).toContain(EVENT.EXECUTION_SUCCEEDED);
  });

  it('exhausts three attempts and fails verification_failed', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-ver-exhaust', verificationCommand: 'false' }));
    const sessionId = job.opencodeSessionId!;
    const now = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      ctx.stub.messages[sessionId] = [
        done(`m${attempt}`, `attempt ${attempt}`, now + attempt),
        ...(attempt > 1 ? [ctx.stub.messages[sessionId]![0]!] : []),
      ];
      await ctx.engine.pollJob((await getJobByHubId(pool, 'job-ver-exhaust'))!);
      await ctx.engine.drain();
    }
    const row = (await getJobByHubId(pool, 'job-ver-exhaust'))!;
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('verification_failed');
    expect(row.failureReason).toContain('3');
    expect(row.failureReason).toContain('exit code 1');
    expect(ctx.stub.prompts).toHaveLength(3); // initial + two repairs
    const types = await eventTypes(pool, row.id);
    expect(types.filter((type) => type === EVENT.EXECUTION_FAILED)).toHaveLength(1);
  });

  it('a manual /verify after failure gets a fresh attempt counter and can succeed', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-verify-manual', verificationCommand: 'test -f manual.ok' }));
    ctx.stub.messages[job.opencodeSessionId!] = [done('m1', 'worked', Date.now())];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-verify-manual'))!);
    await ctx.engine.drain();
    expect((await getJobByHubId(pool, 'job-verify-manual'))!.status).toBe('running'); // repaired

    // Fail it out: cancel the repair loop by exhausting… instead simply fail twice more quickly.
    for (let attempt = 2; attempt <= 3; attempt++) {
      ctx.stub.messages[job.opencodeSessionId!] = [
        done(`m${attempt}`, `attempt ${attempt}`, Date.now() + attempt),
        ctx.stub.messages[job.opencodeSessionId!]![0]!,
      ];
      await ctx.engine.pollJob((await getJobByHubId(pool, 'job-verify-manual'))!);
      await ctx.engine.drain();
    }
    expect((await getJobByHubId(pool, 'job-verify-manual'))!.status).toBe('failed');

    // The manual re-verify: fresh counter, and now the check passes.
    writeFileSync(join(job.worktreePath, 'manual.ok'), 'ok');
    const verifying = await ctx.engine.verifyNow('job-verify-manual');
    expect(verifying.status).toBe('verifying');
    expect(verifying.verificationAttemptCount).toBe(0);
    await ctx.engine.drain();
    const final = (await getJobByHubId(pool, 'job-verify-manual'))!;
    expect(final.status).toBe('succeeded');
    expect(final.verificationAttemptCount).toBe(1);
    expect((final.metadata.verification as { exitCode?: number }).exitCode).toBe(0);
  });
});

describe('merge', () => {
  it('merges clean work into the base branch, records merged_sha and removes the workspace', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-merge-ok', title: 'Merge feature' }));
    writeFileSync(join(job.worktreePath, 'feature.txt'), 'feature work\n');
    ctx.stub.messages[job.opencodeSessionId!] = [done('m1', 'Feature complete.', Date.now())];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-merge-ok'))!);
    await ctx.engine.drain();
    expect((await getJobByHubId(pool, 'job-merge-ok'))!.status).toBe('succeeded');

    const outcome = await ctx.engine.mergeJob('job-merge-ok');
    expect(outcome).toMatchObject({ merged: true });
    expect(typeof outcome.mergeSha).toBe('string');

    const row = (await getJobByHubId(pool, 'job-merge-ok'))!;
    expect(row.mergedSha).toBe(outcome.mergeSha);

    // The base checkout (on its default branch) now carries the file.
    expect(readFileSync(join(repoRoot, 'feature.txt'), 'utf8')).toBe('feature work\n');
    const log = await execGit(['log', '--format=%s', '-n', '1'], { cwd: repoRoot });
    expect(log.stdout).toContain('executor: merge');

    // Workspace gone; the log endpoint shape flips to gone.
    expect(existsSync(job.worktreePath)).toBe(false);
    const types = await eventTypes(pool, row.id);
    expect(types).toContain(EVENT.WORKTREE_MERGED);
  });

  it('reports conflicts and leaves the workspace for recovery', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-merge-conflict' }));
    writeFileSync(join(job.worktreePath, 'README.md'), 'job version\n');
    ctx.stub.messages[job.opencodeSessionId!] = [done('m1', 'Changed README.', Date.now())];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-merge-conflict'))!);
    await ctx.engine.drain();
    expect((await getJobByHubId(pool, 'job-merge-conflict'))!.status).toBe('succeeded');

    // Move the base ahead with a competing change to the same file.
    writeFileSync(join(repoRoot, 'README.md'), 'base version\n');
    await execGit(['add', '-A', '--', '.'], { cwd: repoRoot });
    await execGit(['commit', '-m', 'competing change'], {
      cwd: repoRoot,
      env: { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
    });

    const outcome = await ctx.engine.mergeJob('job-merge-conflict');
    expect(outcome.merged).toBe(false);
    expect(outcome.conflicts).toContain('README.md');
    expect(existsSync(job.worktreePath)).toBe(true); // left for recovery
    const types = await eventTypes(pool, (await getJobByHubId(pool, 'job-merge-conflict'))!.id);
    expect(types).toContain(EVENT.WORKTREE_MERGE_FAILED);

    // Recover: resolve in the worktree by hand, then merge again.
    writeFileSync(join(job.worktreePath, 'README.md'), 'resolved\n');
    await commitJobChanges(execGit, { path: job.worktreePath, message: 'resolve' });
    void 0;
  });

  it('409s when the worktree carries unresolved conflicts', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-merge-guard' }));
    writeFileSync(join(job.worktreePath, 'README.md'), 'job side\n');
    ctx.stub.messages[job.opencodeSessionId!] = [done('m1', 'changed', Date.now())];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-merge-guard'))!);
    await ctx.engine.drain();

    // Competing base change, then a by-hand in-worktree merge left unresolved.
    const snapshotWorktree = await execGit(['rev-parse', 'HEAD'], { cwd: job.worktreePath });
    void snapshotWorktree;
    writeFileSync(join(repoRoot, 'README.md'), 'other base side\n');
    await execGit(['add', '-A', '--', '.'], { cwd: repoRoot });
    await execGit(['commit', '-m', 'competing 2'], {
      cwd: repoRoot,
      env: { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
    });
    const merge = await execGit(['merge', 'HEAD', '--no-edit', 'main'], { cwd: job.worktreePath });
    void merge;
    const unmerged = await execGit(['diff', '--name-only', '--diff-filter=U'], { cwd: job.worktreePath });
    expect(unmerged.stdout).toContain('README.md');

    await expect(ctx.engine.mergeJob('job-merge-guard')).rejects.toMatchObject({
      statusCode: 409,
      extra: expect.objectContaining({ conflicts: ['README.md'] }),
    });
    await execGit(['merge', '--abort'], { cwd: job.worktreePath });
    await ctx.engine.cancel('job-merge-guard');
  });
});

describe('in-job retries', () => {
  function errored(id: string, error: Record<string, unknown>, created: number): OpenCodeMessage {
    return { id, type: 'assistant', finish: 'error', error, content: [], time: { created } };
  }

  it('a retryable failure requeues the SAME job, keeps the branch, and continues with a preamble', async () => {
    const ctx = makeEngine({ retryMaxAttempts: 2, retryDelayMinutes: 0 });
    const job = await runningJob(ctx, spec({ jobId: 'job-retry-1', prompt: 'Implement the feature.' }));
    const firstBranch = job.branch;
    const firstPath = job.worktreePath;
    const firstSession = job.opencodeSessionId!;
    // Real work on the branch, so the continuation is observable.
    writeFileSync(join(firstPath, 'feature.txt'), 'attempt one work\n');

    ctx.stub.messages[firstSession] = [errored('m-err', { type: 'provider.error', message: 'the turn blew up' }, Date.now())];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-retry-1'))!);

    let row = (await getJobByHubId(pool, 'job-retry-1'))!;
    expect(row.status).toBe('queued');
    expect(row.attemptCount).toBe(2);
    expect(row.maxAttempts).toBe(2);
    expect(row.opencodeSessionId).toBeNull();
    expect(row.errorCode).toBe('agent_error');
    let types = await eventTypes(pool, row.id);
    expect(types).toContain('AUTO_RETRY_SCHEDULED');
    expect(types).not.toContain('EXECUTION_FAILED');
    // The failed attempt's leftovers were checkpointed onto the branch (the
    // poll's safety-net commit or failJob's own — either way it is ON it).
    const onBranch = await execGit(['show', `${firstBranch}:feature.txt`], { cwd: repoRoot });
    expect(onBranch.stdout).toBe('attempt one work\n');

    // Admission relaunches it (no backoff): SAME branch, fresh session,
    // the original prompt behind the continuation preamble.
    await ctx.engine.admitQueued();
    row = (await getJobByHubId(pool, 'job-retry-1'))!;
    expect(row.status).toBe('running');
    expect(row.branch).toBe(firstBranch);
    expect(row.worktreePath).toBe(firstPath);
    expect(row.opencodeSessionId).not.toBe(firstSession);
    expect(ctx.stub.sessions).toHaveLength(2);
    const relaunchPrompt = ctx.stub.prompts.at(-1)!.text;
    expect(relaunchPrompt).toContain('This is attempt 2 of 2');
    expect(relaunchPrompt).toContain('agent_error');
    expect(relaunchPrompt).toContain('committed on this branch');
    expect(relaunchPrompt).toContain('Implement the feature.');
    types = await eventTypes(pool, row.id);
    expect(types).toContain('AUTO_RETRY_STARTED');

    // The retry finishes the job — the worktree still carries attempt 1's file.
    expect(readFileSync(join(firstPath, 'feature.txt'), 'utf8')).toBe('attempt one work\n');
    ctx.stub.messages[row.opencodeSessionId!] = [done('m-done', 'Feature done on attempt 2.', Date.now())];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-retry-1'))!);
    await ctx.engine.drain();
    row = (await getJobByHubId(pool, 'job-retry-1'))!;
    expect(row.status).toBe('succeeded');
    expect(row.summary).toBe('Feature done on attempt 2.');
  });

  it('re-attaches a removed worktree on the SAME branch when the retry launches', async () => {
    const ctx = makeEngine({ retryMaxAttempts: 2, retryDelayMinutes: 0 });
    const job = await runningJob(ctx, spec({ jobId: 'job-retry-gone' }));
    const firstBranch = job.branch;
    writeFileSync(join(job.worktreePath, 'keep.txt'), 'keep me\n');
    ctx.stub.messages[job.opencodeSessionId!] = [errored('m-err', { message: 'boom' }, Date.now())];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-retry-gone'))!);
    expect((await getJobByHubId(pool, 'job-retry-gone'))!.status).toBe('queued');

    // Simulate a cleanup that removed the worktree but kept the branch.
    await execGit(['worktree', 'remove', '--force', job.worktreePath], { cwd: repoRoot });
    expect(existsSync(job.worktreePath)).toBe(false);

    await ctx.engine.admitQueued();
    const row = (await getJobByHubId(pool, 'job-retry-gone'))!;
    expect(row.status).toBe('running');
    expect(row.branch).toBe(firstBranch);
    // The branch's committed work is back in the re-attached worktree.
    expect(readFileSync(join(row.worktreePath, 'keep.txt'), 'utf8')).toBe('keep me\n');
    await ctx.engine.cancel('job-retry-gone');
  });

  it('honours the backoff window between attempts', async () => {
    const ctx = makeEngine({ retryMaxAttempts: 2, retryDelayMinutes: 30 });
    await runningJob(ctx, spec({ jobId: 'job-retry-backoff' }));
    ctx.stub.messages[(await getJobByHubId(pool, 'job-retry-backoff'))!.opencodeSessionId!] = [
      errored('m-err', { message: 'boom' }, Date.now()),
    ];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-retry-backoff'))!);
    const row = (await getJobByHubId(pool, 'job-retry-backoff'))!;
    expect(row.status).toBe('queued');
    expect(row.retryBackoffUntil).not.toBeNull();
    expect(row.retryBackoffUntil!.getTime()).toBeGreaterThan(Date.now() + 29 * 60_000);

    // The backoff holds the job queued: admission does not launch it yet.
    await ctx.engine.admitQueued();
    expect((await getJobByHubId(pool, 'job-retry-backoff'))!.status).toBe('queued');
    expect(ctx.stub.sessions).toHaveLength(1);

    // The window passing releases it.
    await pool.query(`UPDATE executor.jobs SET retry_backoff_until = NOW() WHERE hub_job_id = 'job-retry-backoff'`);
    await ctx.engine.admitQueued();
    expect((await getJobByHubId(pool, 'job-retry-backoff'))!.status).toBe('running');
    await ctx.engine.cancel('job-retry-backoff');
  });

  it('budget exhaustion fails terminally with retryExhausted, without touching the branch', async () => {
    const ctx = makeEngine({ retryMaxAttempts: 2, retryDelayMinutes: 0 });
    await runningJob(ctx, spec({ jobId: 'job-retry-dead' }));
    ctx.stub.messages[(await getJobByHubId(pool, 'job-retry-dead'))!.opencodeSessionId!] = [
      errored('m-err-1', { message: 'boom 1' }, Date.now()),
    ];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-retry-dead'))!);
    await ctx.engine.admitQueued();
    let row = (await getJobByHubId(pool, 'job-retry-dead'))!;
    expect(row.attemptCount).toBe(2);

    ctx.stub.messages[row.opencodeSessionId!] = [errored('m-err-2', { message: 'boom 2' }, Date.now())];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-retry-dead'))!);
    row = (await getJobByHubId(pool, 'job-retry-dead'))!;
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('agent_error');
    const events = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM executor.job_events WHERE job_id = $1 AND event_type = 'EXECUTION_FAILED'`, [row.id]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.payload).toMatchObject({ code: 'agent_error', attempts: 2, maxAttempts: 2, retryExhausted: true });
    // The workspace survives for inspection/recovery; the branch still exists.
    expect(existsSync(row.worktreePath)).toBe(true);
  });

  it('non-retryable failures stay terminal even with budget left', async () => {
    const ctx = makeEngine({ retryMaxAttempts: 3, retryDelayMinutes: 0 });
    const job = await runningJob(ctx, spec({ jobId: 'job-retry-config', verificationCommand: 'false' }));
    ctx.stub.messages[job.opencodeSessionId!] = [done('m1', 'done work', Date.now())];
    // Exhaust the verification repair loop (3 attempts).
    const now = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      ctx.stub.messages[job.opencodeSessionId!] = [
        done(`m${attempt + 10}`, `attempt ${attempt}`, now + attempt),
      ];
      await ctx.engine.pollJob((await getJobByHubId(pool, 'job-retry-config'))!);
      await ctx.engine.drain();
    }
    const row = (await getJobByHubId(pool, 'job-retry-config'))!;
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('verification_failed');
    expect(row.attemptCount).toBe(1); // never requeued: verification repair IS the inner retry
  });

  it('requeues a failed session setup within budget', async () => {
    const ctx = makeEngine({ retryMaxAttempts: 2 });
    // No localPath/repoUrl: the launch dies before any workspace exists —
    // createJob's own admission burns attempt 1, the requeue parks queued.
    await ctx.engine.createJob(spec({ jobId: 'job-retry-setup', prompt: 'x', project: null }));
    let row = (await getJobByHubId(pool, 'job-retry-setup'))!;
    expect(row.status).toBe('queued');
    expect(row.errorCode).toBe('session_setup_failed');
    expect(row.attemptCount).toBe(2);
    // The setup keeps failing; the next admission burns the last attempt → terminal.
    await ctx.engine.admitQueued();
    row = (await getJobByHubId(pool, 'job-retry-setup'))!;
    expect(row.status).toBe('failed');
    expect(row.attemptCount).toBe(2);
  });
});

describe('model fallback', () => {
  it('switches to the next priority model on a usage-limit error and continues in the SAME session', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({
      jobId: 'job-fallback', models: ['litellm/open-large', 'kimi/k2'],
    }));
    expect(job.model).toBe('litellm/open-large');
    const sessionId = job.opencodeSessionId!;
    ctx.stub.messages[sessionId] = [{
      id: 'm-limit', type: 'assistant', finish: 'error',
      error: { type: 'provider.rate_limit', status: 429, message: 'Rate limit reached.' },
      content: [], time: { created: Date.now() },
    }];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-fallback'))!);

    const row = (await getJobByHubId(pool, 'job-fallback'))!;
    expect(row.status).toBe('running'); // not failed
    expect(row.model).toBe('kimi/k2');
    expect(ctx.stub.modelSwitches).toEqual([{ sessionId, model: { providerID: 'kimi', modelID: 'k2' } }]);
    const continuation = ctx.stub.prompts.at(-1)!;
    expect(continuation.sessionId).toBe(sessionId);
    expect(continuation.text).toContain('hit its usage limit');
    expect(continuation.text).toContain('kimi/k2');
    const types = await eventTypes(pool, row.id);
    expect(types).toContain('MODEL_FALLBACK');
    expect(types).not.toContain('EXECUTION_FAILED');

    // The same errored message re-polled never falls back twice.
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-fallback'))!);
    expect(ctx.stub.modelSwitches).toHaveLength(1);

    // A later limit on the LAST model fails the job (no third model).
    ctx.stub.messages[sessionId] = [{
      id: 'm-limit-2', type: 'assistant', finish: 'error',
      error: { type: 'provider.rate_limit', status: 429, message: 'Rate limit reached again.' },
      content: [], time: { created: Date.now() + 1 },
    }];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-fallback'))!);
    const dead = (await getJobByHubId(pool, 'job-fallback'))!;
    expect(dead.status).toBe('failed');
    expect(dead.errorCode).toBe('agent_error');
  });

  it('auth-shaped errors never fall back (a missing key cannot be fixed by switching)', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-auth-fail', models: ['litellm/open-large', 'kimi/k2'] }));
    ctx.stub.messages[job.opencodeSessionId!] = [{
      id: 'm-auth', type: 'assistant', finish: 'error',
      error: { type: 'provider.auth', status: 401, message: 'No api key passed in.' },
      content: [], time: { created: Date.now() },
    }];
    await ctx.engine.pollJob((await getJobByHubId(pool, 'job-auth-fail'))!);
    expect(ctx.stub.modelSwitches).toHaveLength(0);
    expect((await getJobByHubId(pool, 'job-auth-fail'))!.status).toBe('failed');
  });
});

describe('verification reclaim', () => {
  it('re-adopts a detached verifying cycle after a restart (fresh engine, same row)', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-verify-reclaim', verificationCommand: 'true' }));
    // Simulate the crash: the row sits `verifying` with NO detached cycle
    // anywhere (the fresh engine below owns an empty in-memory set).
    await pool.query(`UPDATE executor.jobs SET status = 'verifying' WHERE hub_job_id = 'job-verify-reclaim'`);

    const restarted = makeEngine();
    await restarted.engine.tick();
    await restarted.engine.drain();

    const row = (await getJobByHubId(pool, 'job-verify-reclaim'))!;
    expect(row.status).toBe('succeeded');
    const types = await eventTypes(pool, row.id);
    expect(types).toContain(EVENT.VERIFICATION_PASSED);
    void job;
  });

  it('fails a verifying job whose workspace vanished instead of waiting for the ceiling', async () => {
    const ctx = makeEngine({ jobTimeoutMs: 0 });
    await runningJob(ctx, spec({ jobId: 'job-verify-gone', verificationCommand: 'true' }));
    await pool.query(`UPDATE executor.jobs SET status = 'verifying' WHERE hub_job_id = 'job-verify-gone'`);
    await execGit(['worktree', 'remove', '--force', (await getJobByHubId(pool, 'job-verify-gone'))!.worktreePath], { cwd: repoRoot });

    await ctx.engine.tick();
    await ctx.engine.drain();
    const row = (await getJobByHubId(pool, 'job-verify-gone'))!;
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('verification_failed');
    // Not retryable: stays failed on the first verdict.
    expect(row.attemptCount).toBe(1);
  });
});

describe('terminal actions', () => {
  it('cancels idempotently with an interrupt', async () => {
    const ctx = makeEngine();
    const job = await runningJob(ctx, spec({ jobId: 'job-cancel' }));
    const first = await ctx.engine.cancel('job-cancel');
    expect(first?.status).toBe('cancelled');
    expect(ctx.stub.interrupts).toContain(job.opencodeSessionId);
    const second = await ctx.engine.cancel('job-cancel');
    expect(second?.status).toBe('cancelled');
    const types = await eventTypes(pool, job.id);
    expect(types.filter((type) => type === EVENT.EXECUTION_CANCELLED)).toHaveLength(1);
  });

  it('rejects messages to terminal jobs', async () => {
    const ctx = makeEngine();
    await runningJob(ctx, spec({ jobId: 'job-dead' }));
    await ctx.engine.cancel('job-dead');
    await expect(ctx.engine.sendMessage('job-dead', 'hello')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('repairPrompt carries the command, exit code and output', async () => {
    expect(repairPrompt('npm test', { code: 1, output: '2 failing' })).toContain('`npm test` failed with exit code 1');
    void pool;
  });

  it('stallFailureReason explains the wedge without hub-version specifics', () => {
    const reason = stallFailureReason('a tool has been running for 51 minutes with no progress', true);
    expect(reason).toContain('Agent stalled — a tool has been running for 51 minutes');
    expect(reason).toContain('interrupted');
  });
});

describe('testkit sanity', () => {
  it('makeRepo produced a repo on its default branch with one commit', async () => {
    const log = await execGit(['log', '--oneline'], { cwd: repoRoot });
    expect(log.stdout).toContain('initial');
    void mkdirSync;
  });
});
