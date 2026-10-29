import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { WebSocketServer, type WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthHook, hashToken, writeAuthConfig } from './auth.js';
import { createPool, defaultMigrationsDir, runModuleMigrations } from './db.js';
import { EVENT, getJobByHubId, JobEngine, type JobSpecInput } from './engine.js';
import { enrollGateway, runGatewayLoop } from './gateway.js';
import { GATEWAY_PROTOCOL_VERSION, type RouteDeps } from './ops.js';
import { registerRoutes } from './routes.js';
import { makeRepo, makeStubClient, TEST_AUTHOR, testConfig } from './testkit.js';
import { execGit, type GitRunner } from './workspace.js';

// A real 1x1 PNG, not UTF-8 text masquerading as an image.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const skillBody = '---\nname: executor-acceptance-fixture\ndescription: Load the isolated acceptance fixture\n---\nRead references/fixture.txt.\n';
const resource = 'EXECUTOR_ACCEPTANCE_COMPANION_91d7\n';
const files = [{ path: 'SKILL.md', text: skillBody }, { path: 'references/fixture.txt', text: resource }];
const digest = createHash('sha256');
for (const file of files) digest.update(`${file.path}\0${Buffer.byteLength(file.text)}\0`).update(file.text);
const skill = { id: 'executor-acceptance-fixture', sha256: digest.digest('hex'),
  files: files.map(({ path, text }) => ({ path, dataBase64: Buffer.from(text).toString('base64') })) };
const token = 'isolated-acceptance-token-not-a-live-credential';
let pool: Pool;
let root: string;

beforeAll(async () => {
  pool = createPool(process.env.DATABASE_URL!);
  await pool.query('DROP SCHEMA IF EXISTS executor CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS platform CASCADE');
  await runModuleMigrations(pool, 'executor', 'executor', defaultMigrationsDir());
  await writeAuthConfig(pool, { tokenHash: hashToken(token), hubUrl: 'http://fixture.invalid', name: 'acceptance', pairedAt: new Date().toISOString() });
  root = mkdtempSync('/tmp/opencode/executor-materialization-');
});

afterAll(async () => {
  await pool.end();
  rmSync(root, { recursive: true, force: true });
});

type Transport = 'direct' | 'gateway';
async function fixture(transport: Transport, git: GitRunner = execGit) {
  const dir = join(root, randomUUID());
  const repo = await makeRepo(join(dir, 'repo'));
  const config = testConfig(join(dir, 'workspaces'), { maxParallelJobs: 20 });
  const stub = makeStubClient();
  const errors: unknown[] = [];
  const engine = new JobEngine({ pool, config, client: stub.client, git, onError: (error) => errors.push(error) });
  // Terminal and upgrade operations are intentionally outside this test's surface.
  const deps = { pool, config, engine, client: stub.client, startedAt: Date.now() } as RouteDeps;
  let request: (operation: string, payload: any) => Promise<{ status: number; body: any }>;
  let closeTransport: () => Promise<void>;
  if (transport === 'direct') {
    const app = Fastify({ logger: false });
    app.addHook('preHandler', createAuthHook(pool));
    registerRoutes(app, deps);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    request = async (operation, payload) => {
      const path = operation === 'job.dispatch' ? '/api/v1/jobs' : `/api/v1/jobs/${payload.jobId}/merge`;
      const response = await fetch(`${address}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(operation === 'job.dispatch' ? payload.job : {}) });
      return { status: response.status, body: await response.json() };
    };
    closeTransport = () => app.close();
  } else {
    // Real loopback WebSocket + production executor reconnect/dispatch loop.
    // This is not the separately deployed gateway relay/authentication service.
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const address = server.address() as { port: number };
    const gatewayConfig = { ...config, gatewayUrl: `http://127.0.0.1:${address.port}`, gatewayIdentityPath: join(dir, 'identity.json'), pairCode: 'FIXTURE' };
    await enrollGateway(gatewayConfig, { fetchImpl: (async () => new Response(JSON.stringify({ credential: token, executorId: 'fixture' }))) as typeof fetch });
    const connected = once(server, 'connection');
    let stopped = false;
    const loop = runGatewayLoop(deps, gatewayConfig, { logger: { info() {}, warn() {} }, isStopped: () => stopped });
    const [socket] = await connected as [WebSocket];
    request = async (operation, payload) => {
      const reply = once(socket, 'message');
      socket.send(JSON.stringify({ version: GATEWAY_PROTOCOL_VERSION, type: 'request', id: randomUUID(), operation, payload }));
      const [data] = await reply;
      const envelope = JSON.parse(data.toString());
      expect(envelope.operation).toBe(operation);
      return { status: envelope.payload.ok ? 200 : envelope.payload.status, body: envelope.payload.ok ? envelope.payload.result : envelope.payload };
    };
    closeTransport = async () => {
      stopped = true;
      socket.close();
      await loop;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    };
  }
  const jobId = randomUUID();
  const spec: JobSpecInput = { jobId, title: 'Isolated materialization acceptance', prompt: 'Inspect the fixture PNG and load executor-acceptance-fixture. Report a missing skill explicitly.',
    project: { localPath: repo }, baseBranch: 'fixture-stage', attachments: [
      { name: '../.diagram.png', mimeType: 'image/png', dataBase64: png.toString('base64') },
      { name: '..\\diagram.png', mimeType: 'image/png', dataBase64: png.toString('base64') },
    ], agent: { name: 'Acceptance Fixture', opencodeAgent: 'acceptance-fixture', markdown: '---\nmode: primary\n---\nUse only the isolated fixture.', mcp: null, skills: [skill] } };
  const dispatch = async () => {
    expect((await execGit(['branch', spec.baseBranch!], { cwd: repo })).code).toBe(0);
    const response = await request('job.dispatch', { job: spec });
    expect(response.status).toBe(transport === 'direct' ? 201 : 200);
    return (await getJobByHubId(pool, jobId))!;
  };
  const prepared = async () => {
    const job = await dispatch();
    const path = join(config.workspaceRoot, 'worktrees', `stage-${job.id}`);
    expect((await execGit(['worktree', 'add', path, spec.baseBranch!], { cwd: repo })).code).toBe(0);
    return path;
  };
  const launch = async () => {
    await engine.admitQueued();
    await engine.drain();
    expect(errors).toEqual([]);
    return (await getJobByHubId(pool, jobId))!;
  };
  return { dir, repo, spec, stub: stub.state, engine, request, dispatch, prepared, launch,
    close: async () => { await engine.cancel(jobId); await engine.drain(); await closeTransport(); } };
}

describe.each<Transport>(['direct', 'gateway'])('%s engine materialization acceptance', (transport) => {
  it.skipIf(process.env.EXECUTOR_ACCEPTANCE_REAL_OPENCODE !== 'true')('real OpenCode discovers and activates the installed skill, reports a missing skill and serves resource/PNG bytes (no model execution)', async () => {
    const f = await fixture(transport);
    try {
      await f.dispatch();
      const job = await f.launch();
      expect(job.status, job.failureReason ?? undefined).toBe('running');
      const base = process.env.OPENCODE_BASE_URL?.replace(/\/+$/, '');
      expect(base).toBeTruthy();
      const password = process.env.OPENCODE_TOKEN ?? '';
      const authorization = /^(basic|bearer)\s/i.test(password) ? password : `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
      const get = (path: string, directory = job.worktreePath) => fetch(`${base}${path}?${new URLSearchParams({ 'location[directory]': directory })}`, {
        headers: { authorization }, signal: AbortSignal.timeout(15_000),
      });
      // Unignored control distinguishes runtime discovery trouble from the
      // engine's excluded delivery path. All files remain under this fixture.
      const control = await makeRepo(join(f.dir, 'discovery-control'));
      mkdirSync(join(control, '.opencode/skills', skill.id), { recursive: true });
      writeFileSync(join(control, '.opencode/skills', skill.id, 'SKILL.md'), skillBody);
      await expect.poll(async () => {
        const controlResponse = await get('/api/skill', control);
        expect(controlResponse.status).toBe(200);
        const controlBody = await controlResponse.json() as { data: Array<{ id: string }> };
        return controlBody.data.some((entry) => entry.id === skill.id);
      }, { timeout: 5_000, message: 'unignored discovery control' }).toBe(true);
      const discovered = await get('/api/skill');
      expect(discovered.status).toBe(200);
      const body = await discovered.json() as { location: { directory: string }; data: Array<{ id: string; description: string; path?: string }> };
      expect(body.location.directory).toBe(job.worktreePath);
      for (const [path, expected] of [
        [`.opencode/skills/${skill.id}/SKILL.md`, Buffer.from(skillBody)],
        [`.opencode/skills/${skill.id}/references/fixture.txt`, Buffer.from(resource)],
        ['builder-input/diagram.png', png],
      ] as const) {
        const response = await get(`/api/fs/read/${path}`);
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
      }
      await expect.poll(async () => {
        const response = await get('/api/skill');
        expect(response.status).toBe(200);
        const current = await response.json() as typeof body;
        expect(current.location.directory).toBe(job.worktreePath);
        return current.data.find((entry) => entry.id === skill.id);
      }, { timeout: 5_000, message: 'materialized worktree skill discovery' }).toMatchObject({
        id: skill.id, description: 'Load the isolated acceptance fixture', path: join(job.worktreePath, '.opencode/skills', skill.id, 'SKILL.md'),
      });
      // A disposable session pins the materialized fixture persona. No model
      // is requested and no prompt is sent; resume:false prevents generation.
      const call = (path: string, method: string, payload?: unknown) => fetch(`${base}${path}`, {
        method, headers: { authorization, 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(15_000),
      });
      const created = await call('/api/session', 'POST', { title: `Executor acceptance ${transport} ${f.spec.jobId}`, agent: 'acceptance-fixture',
        location: { directory: job.worktreePath }, permissions: [{ action: '*', resource: '*', effect: 'deny' }, { action: 'skill', resource: skill.id, effect: 'allow' }] });
      expect(created.status).toBe(200);
      const sessionId = (await created.json() as { data: { id: string } }).data.id;
      try {
        const activated = await call(`/api/experimental/session/${sessionId}/skill`, 'POST', { id: skill.id, resume: false });
        expect(activated.status).toBe(204);
        const missingId = 'executor-acceptance-missing-91d7';
        const missing = await call(`/api/experimental/session/${sessionId}/skill`, 'POST', { id: missingId, resume: false });
        expect(missing.status).toBe(404);
        expect(await missing.text()).toContain(missingId);
        const messages = await call(`/api/session/${sessionId}/message`, 'GET');
        expect(messages.status).toBe(200);
        const history = await messages.json() as { data: Array<{ type: string; skill?: string; text?: string }> };
        const loaded = history.data.find((message) => message.type === 'skill' && message.skill === skill.id);
        expect(loaded?.text).toContain('Read references/fixture.txt.');
        expect(history.data.some((message) => ['assistant', 'idle'].includes(message.type))).toBe(false);
      } finally {
        expect((await call(`/api/session/${sessionId}`, 'DELETE')).status).toBe(204);
      }
      // Native activation is genuine loader evidence, NOT evidence that an LLM
      // invoked the skill tool, read the companion, or interpreted the PNG.
    } finally { await f.close(); }
  }, 20_000);

  it('preserves PNG bytes, exact sanitized duplicate paths and skill resources, excluding all private bytes from add/commit/merge', async () => {
    const f = await fixture(transport);
    try {
      await f.dispatch();
      const job = await f.launch();
      expect(job.status, job.failureReason ?? undefined).toBe('running');
      expect(readdirSync(join(job.worktreePath, 'builder-input')).sort()).toEqual(['diagram-2.png', 'diagram.png']);
      for (const name of ['diagram.png', 'diagram-2.png']) expect(readFileSync(join(job.worktreePath, 'builder-input', name))).toEqual(png);
      expect(f.stub.prompts[0].text).toContain('builder-input/diagram.png');
      expect(f.stub.prompts[0].text).toContain('builder-input/diagram-2.png');
      expect(f.stub.prompts[0].text).not.toContain('../.diagram.png');
      for (const file of files) expect(readFileSync(join(job.worktreePath, '.opencode/skills', skill.id, file.path), 'utf8')).toBe(file.text);
      expect(f.stub.sessions[0]).toMatchObject({ directory: job.worktreePath, agent: 'acceptance-fixture' });
      const applied = await pool.query('SELECT payload FROM executor.job_events WHERE job_id=$1 AND event_type=$2', [job.id, EVENT.AGENT_APPLIED]);
      expect(applied.rows[0].payload.skills).toEqual([{ id: skill.id, sha256: skill.sha256 }]);
      writeFileSync(join(job.worktreePath, 'feature.txt'), 'public feature\n');
      expect((await execGit(['add', '-A'], { cwd: job.worktreePath })).code).toBe(0);
      expect((await execGit(['diff', '--cached', '--name-only'], { cwd: job.worktreePath })).stdout.trim()).toBe('feature.txt');
      f.stub.messages[job.opencodeSessionId!] = [{ id: 'fixture-done', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'Fixture done (scripted; not LLM loading evidence).' }], time: { created: Date.now() } }];
      await f.engine.pollJob(job);
      expect((await getJobByHubId(pool, f.spec.jobId))!.status).toBe('succeeded');
      const committed = (await execGit(['ls-tree', '-r', '--name-only', job.branch], { cwd: f.repo })).stdout;
      expect(committed).toContain('feature.txt');
      expect(committed).not.toMatch(/builder-input|\.opencode/);
      const merge = await f.request('job.merge', { jobId: f.spec.jobId });
      expect(merge.status).toBe(200);
      const merged = (await execGit(['ls-tree', '-r', '--name-only', 'main'], { cwd: f.repo })).stdout;
      expect(merged).toContain('feature.txt');
      expect(merged).not.toMatch(/builder-input|\.opencode/);
      expect(readFileSync(join(f.repo, 'feature.txt'), 'utf8')).toBe('public feature\n');
    } finally { await f.close(); }
  });

  it('rejects a tracked attachment collision before writing any PNG or starting a session', async () => {
    const f = await fixture(transport);
    try {
      mkdirSync(join(f.repo, 'builder-input'));
      writeFileSync(join(f.repo, 'builder-input/diagram-2.png'), 'tracked original');
      await execGit(['add', '-A'], { cwd: f.repo });
      await execGit(['commit', '-m', 'tracked collision'], { cwd: f.repo, env: TEST_AUTHOR });
      await f.dispatch();
      const job = await f.launch();
      expect(readFileSync(join(job.worktreePath, 'builder-input/diagram-2.png'), 'utf8')).toBe('tracked original');
      expect(job.status).toBe('failed');
      expect(job.errorCode).toBe('workspace_setup_failed');
      expect(job.failureReason).toMatch(/tracked/i);
      expect(existsSync(join(job.worktreePath, 'builder-input/diagram.png'))).toBe(false);
      expect(f.stub.sessions).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(['directory', 'file', 'dangling-file'])('rejects an attachment %s symlink escape before any sensitive write', async (kind) => {
    const f = await fixture(transport);
    try {
      const path = await f.prepared();
      const outside = join(f.dir, 'outside');
      mkdirSync(outside);
      const victim = join(outside, 'victim.png');
      if (kind !== 'dangling-file') writeFileSync(victim, 'outside original');
      if (kind === 'directory') symlinkSync(outside, join(path, 'builder-input'));
      else {
        mkdirSync(join(path, 'builder-input'));
        symlinkSync(victim, join(path, 'builder-input/diagram-2.png'));
      }
      const job = await f.launch();
      if (kind === 'dangling-file') expect(existsSync(victim)).toBe(false);
      else expect(readFileSync(victim, 'utf8')).toBe('outside original');
      expect(existsSync(join(outside, 'diagram.png'))).toBe(false);
      expect(job.status).toBe('failed');
      expect(job.errorCode).toBe('workspace_setup_failed');
      expect(job.failureReason).toMatch(/unsafe|symlink/i);
      expect(existsSync(join(path, 'builder-input/diagram.png'))).toBe(false);
      expect(f.stub.sessions).toEqual([]);
    } finally { await f.close(); }
  });

  it('rejects a second attachment hardlinked to a tracked file before either attachment is written', async () => {
    const f = await fixture(transport);
    try {
      writeFileSync(join(f.repo, 'secret.txt'), 'tracked secret fixture');
      await execGit(['add', '-A'], { cwd: f.repo });
      await execGit(['commit', '-m', 'tracked hardlink victim'], { cwd: f.repo, env: TEST_AUTHOR });
      const path = await f.prepared();
      mkdirSync(join(path, 'builder-input'));
      const secret = join(path, 'secret.txt');
      const destination = join(path, 'builder-input/diagram-2.png');
      linkSync(secret, destination);
      const before = statSync(secret);
      const job = await f.launch();
      expect(readFileSync(secret, 'utf8')).toBe('tracked secret fixture');
      expect(readFileSync(destination, 'utf8')).toBe('tracked secret fixture');
      const after = statSync(secret);
      expect({ dev: after.dev, ino: after.ino, nlink: after.nlink }).toEqual({ dev: before.dev, ino: before.ino, nlink: before.nlink });
      expect(existsSync(join(path, 'builder-input/diagram.png'))).toBe(false);
      expect(job.status).toBe('failed');
      expect(job.errorCode).toBe('workspace_setup_failed');
      expect(job.failureReason).toMatch(/hardlink|multiple links/i);
      expect(f.stub.sessions).toEqual([]);
    } finally { await f.close(); }
  });

  it('never truncates a tracked inode when a hardlink appears after destination preflight', async () => {
    let path = '';
    let inserted = false;
    const git: GitRunner = async (args, options) => {
      if (!inserted && args.join(' ') === 'rev-parse --git-path info/exclude') {
        inserted = true;
        linkSync(join(path, 'secret.txt'), join(path, 'builder-input/diagram-2.png'));
      }
      return execGit(args, options);
    };
    const f = await fixture(transport, git);
    try {
      writeFileSync(join(f.repo, 'secret.txt'), 'tracked race fixture');
      await execGit(['add', '-A'], { cwd: f.repo });
      await execGit(['commit', '-m', 'tracked race victim'], { cwd: f.repo, env: TEST_AUTHOR });
      path = await f.prepared();
      mkdirSync(join(path, 'builder-input'));
      const before = statSync(join(path, 'secret.txt'));
      const job = await f.launch();
      expect(inserted).toBe(true);
      expect(readFileSync(join(path, 'secret.txt'), 'utf8')).toBe('tracked race fixture');
      expect(statSync(join(path, 'secret.txt')).ino).toBe(before.ino);
      expect(job.status, job.failureReason ?? undefined).toBe('running');
      expect(readFileSync(join(path, 'builder-input/diagram-2.png'))).toEqual(png);
      expect(statSync(join(path, 'builder-input/diagram-2.png')).ino).not.toBe(before.ino);
    } finally { await f.close(); }
  });

  it.each(['gitignore-new-exclude', 'gitignore-existing-exclude', 'existing-exclude-negation', 'partial-gitignore', 'staging-only-negation'])('fails the whole batch when %s overrides attachment exclusion', async (mode) => {
    const f = await fixture(transport);
    try {
      const negations = '!builder-input/\n!builder-input/**\n';
      if (mode !== 'existing-exclude-negation') {
        const patterns = mode === 'partial-gitignore' ? '!builder-input/\nbuilder-input/*\n!builder-input/diagram-2.png\n'
          : mode === 'staging-only-negation' ? '!builder-input/\nbuilder-input/*\n!builder-input/.attachment-*\n' : negations;
        writeFileSync(join(f.repo, '.gitignore'), patterns);
        await execGit(['add', '.gitignore'], { cwd: f.repo });
        await execGit(['commit', '-m', 'attachment exclusion override'], { cwd: f.repo, env: TEST_AUTHOR });
      }
      const path = await f.prepared();
      if (mode !== 'gitignore-new-exclude') {
        const out = await execGit(['rev-parse', '--git-path', 'info/exclude'], { cwd: path });
        expect(out.code).toBe(0);
        appendFileSync(resolve(path, out.stdout.trim()), `\nbuilder-input/\n${mode === 'existing-exclude-negation' ? negations : ''}`);
      }
      const job = await f.launch();
      expect(existsSync(join(path, 'builder-input/diagram.png'))).toBe(false);
      expect(existsSync(join(path, 'builder-input/diagram-2.png'))).toBe(false);
      if (existsSync(join(path, 'builder-input'))) expect(readdirSync(join(path, 'builder-input'))).toEqual([]);
      expect(job.status).toBe('failed');
      expect(job.errorCode).toBe('workspace_setup_failed');
      expect(job.failureReason).toMatch(/not.*git.ignored/i);
      expect(f.stub.sessions).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(['resolve', 'write'])('fails closed on git exclude %s failure before PNG or skill writes', async (mode) => {
    let invalidExclude = '';
    const git: GitRunner = async (args, options) => args.join(' ') === 'rev-parse --git-path info/exclude'
      ? mode === 'resolve' ? { code: 1, stdout: '', stderr: 'fixture exclude failure' } : { code: 0, stdout: invalidExclude, stderr: '' }
      : execGit(args, options);
    const f = await fixture(transport, git);
    try {
      invalidExclude = join(f.dir, 'not-an-exclude-file');
      mkdirSync(invalidExclude);
      await f.dispatch();
      const job = await f.launch();
      expect(job.status).toBe('failed');
      expect(job.errorCode).toBe('workspace_setup_failed');
      expect(existsSync(join(job.worktreePath, 'builder-input/diagram.png'))).toBe(false);
      expect(existsSync(join(job.worktreePath, '.opencode/skills', skill.id, 'SKILL.md'))).toBe(false);
      expect(f.stub.sessions).toEqual([]);
    } finally { await f.close(); }
  });

  it('reports a delivered bundle missing SKILL.md without accepting a job', async () => {
    const f = await fixture(transport);
    try {
      f.spec.agent!.skills = [{ ...skill, files: skill.files.filter((file) => file.path !== 'SKILL.md') }];
      const response = await f.request('job.dispatch', { job: f.spec });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/missing SKILL.md/i);
      expect(await getJobByHubId(pool, f.spec.jobId)).toBeNull();
      expect(f.stub.sessions).toEqual([]);
    } finally { await f.close(); }
  });

  it('overlays a tracked skill and removes stale resources without staging or merging private replacements', async () => {
    const f = await fixture(transport);
    try {
      const rel = `.opencode/skills/${skill.id}`;
      mkdirSync(join(f.repo, rel), { recursive: true });
      writeFileSync(join(f.repo, rel, 'SKILL.md'), '# tracked original\n');
      writeFileSync(join(f.repo, rel, 'stale.txt'), 'tracked stale\n');
      await execGit(['add', '-A'], { cwd: f.repo });
      await execGit(['commit', '-m', 'tracked skill'], { cwd: f.repo, env: TEST_AUTHOR });
      await f.dispatch();
      const job = await f.launch();
      expect(job.status, job.failureReason ?? undefined).toBe('running');
      expect(readFileSync(join(job.worktreePath, rel, 'SKILL.md'), 'utf8')).toBe(skillBody);
      expect(readFileSync(join(job.worktreePath, rel, 'references/fixture.txt'), 'utf8')).toBe(resource);
      expect(existsSync(join(job.worktreePath, rel, 'stale.txt'))).toBe(false);
      expect(readFileSync(join(f.repo, rel, 'SKILL.md'), 'utf8')).toBe('# tracked original\n');
      writeFileSync(join(job.worktreePath, 'feature.txt'), 'public feature\n');
      await execGit(['add', '-A'], { cwd: job.worktreePath });
      expect((await execGit(['diff', '--cached', '--name-only'], { cwd: job.worktreePath })).stdout.trim()).toBe('feature.txt');
      f.stub.messages[job.opencodeSessionId!] = [{ id: 'overlay-done', type: 'assistant', finish: 'stop', content: [{ type: 'text', text: 'Scripted fixture done.' }], time: { created: Date.now() } }];
      await f.engine.pollJob(job);
      expect((await f.request('job.merge', { jobId: f.spec.jobId })).status).toBe(200);
      expect((await execGit(['show', `main:${rel}/SKILL.md`], { cwd: f.repo })).stdout).toBe('# tracked original\n');
      expect((await execGit(['show', `main:${rel}/stale.txt`], { cwd: f.repo })).stdout).toBe('tracked stale\n');
      expect((await execGit(['ls-tree', '-r', '--name-only', 'main'], { cwd: f.repo })).stdout).not.toContain('references/fixture.txt');
    } finally { await f.close(); }
  });

  it('refuses a symlinked skill root before writing its entry or companion resource', async () => {
    const f = await fixture(transport);
    try {
      f.spec.attachments = [];
      const path = await f.prepared();
      const outside = join(f.dir, 'outside-skills');
      mkdirSync(outside);
      mkdirSync(join(path, '.opencode'));
      symlinkSync(outside, join(path, '.opencode/skills'));
      const job = await f.launch();
      expect(job.status).toBe('failed');
      expect(job.errorCode).toBe('workspace_setup_failed');
      expect(job.failureReason).toMatch(/Unsafe skill destination/);
      expect(readdirSync(outside)).toEqual([]);
      expect(f.stub.sessions).toEqual([]);
    } finally { await f.close(); }
  });

  it('fails skill-only exclude setup before installing the entry or companion resource', async () => {
    const git: GitRunner = (args, options) => args.join(' ') === 'rev-parse --git-path info/exclude'
      ? Promise.resolve({ code: 1, stdout: '', stderr: 'fixture skill exclude failure' }) : execGit(args, options);
    const f = await fixture(transport, git);
    try {
      f.spec.attachments = [];
      await f.dispatch();
      const job = await f.launch();
      expect(job.status).toBe('failed');
      expect(job.errorCode).toBe('workspace_setup_failed');
      expect(existsSync(join(job.worktreePath, '.opencode/skills', skill.id))).toBe(false);
      expect(f.stub.sessions).toEqual([]);
    } finally { await f.close(); }
  });
});
