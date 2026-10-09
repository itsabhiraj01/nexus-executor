import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browseFolders, inspectRepository, type InspectGitRunner } from './fs-discovery.js';
import { handleGatewayOperation, type RouteDeps } from './ops.js';

/**
 * Discovery unit tests: pure tmp-dir filesystem fixtures plus a fake git
 * runner — no database, no sockets. The gateway-dispatch cases pin the
 * payload validation + envelope folding (the ops never touch RouteDeps,
 * so a stub suffices).
 */

let root: string;
let home: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'nexus-exec-fsdisc-'));
  home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  // home tree: services/{api,web}, notes/
  mkdirSync(join(home, 'services', 'api'), { recursive: true });
  mkdirSync(join(home, 'services', 'web'), { recursive: true });
  mkdirSync(join(home, 'notes'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('browseFolders', () => {
  it('empty input lists home, exact pick', () => {
    const result = browseFolders('', home);
    expect(result.path).toBe(home);
    expect(result.probe).toBe(home);
    expect(result.exact).toBe(true);
    expect(result.error).toBeNull();
    expect(result.entries).toEqual(['notes', 'services']);
    expect(result.parent).toBe(root);
  });

  it('~ expands to home; trailing slash drills into the folder itself', () => {
    const tilde = browseFolders('~', home);
    expect(tilde.path).toBe(home);
    expect(tilde.entries).toContain('services');
    const drilled = browseFolders('~/services/', home);
    expect(drilled.path).toBe(join(home, 'services'));
    expect(drilled.probe).toBe(join(home, 'services'));
    expect(drilled.entries).toEqual(['api', 'web']);
    expect(drilled.exact).toBe(true);
  });

  it('a trailing fragment lists the parent and is not exact', () => {
    const result = browseFolders('~/services/ap', home);
    expect(result.path).toBe(join(home, 'services'));
    expect(result.probe).toBe(join(home, 'services', 'ap'));
    expect(result.exact).toBe(false);
    expect(result.entries).toEqual(['api', 'web']);
  });

  it('missing folder with trailing slash answers the soft error', () => {
    const result = browseFolders('~/nope/', home);
    expect(result.error).toBe('No such folder.');
    expect(result.entries).toEqual([]);
    expect(result.exact).toBe(false);
  });

  it('an exact pick carries the marker-file language', () => {
    writeFileSync(join(home, 'services', 'api', 'package.json'), '{}');
    const result = browseFolders('~/services/api', home);
    expect(result.exact).toBe(true);
    expect(result.language).toBe('typescript');
    expect(result.languageSource).toBe('package.json');
    expect(result.languageDir).toBe(join(home, 'services', 'api'));
  });

  it('language markers are sought up the ancestry (go.mod in a parent)', () => {
    writeFileSync(join(home, 'services', 'go.mod'), 'module example.com/x\n');
    const result = browseFolders('~/services/web', home);
    expect(result.language).toBe('go');
    expect(result.languageSource).toBe('go.mod');
    expect(result.languageDir).toBe(join(home, 'services'));
  });

  it('relative input resolves against home', () => {
    const result = browseFolders('services/web', home);
    expect(result.probe).toBe(join(home, 'services', 'web'));
    expect(result.exact).toBe(true);
  });
});

/* — inspectRepository — */

function fakeGit(outcomes: { toplevel?: { code: number; out: string }; abbrevRef?: { code: number; out: string }; short?: { code: number; out: string } }): InspectGitRunner {
  return async (args) => {
    const key = args[1] === '--show-toplevel' ? 'toplevel' : args[1] === '--abbrev-ref' ? 'abbrevRef' : 'short';
    const outcome = outcomes[key] ?? { code: 1, out: '' };
    return { code: outcome.code, stdout: outcome.out };
  };
}

describe('inspectRepository', () => {
  it('non-git directory answers git:false and still reads manifest scripts', async () => {
    const dir = join(home, 'services', 'api');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      scripts: { build: 'tsc -b', start: 'node dist/main.js', dev: 'tsx watch', test: 'vitest run' },
    }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const result = await inspectRepository(dir, { home, git: fakeGit({ toplevel: { code: 128, out: '' } }) });
    expect(result.git).toBe(false);
    expect(result.branch).toBeNull();
    expect(result.repoRoot).toBeNull();
    expect(result.build).toEqual({ command: 'pnpm run build', source: 'package.json scripts.build (pnpm)' });
    expect(result.run).toEqual({ command: 'pnpm start', source: 'package.json scripts.start (pnpm)' });
    expect(result.test).toEqual({ command: 'pnpm test', source: 'package.json scripts.test (pnpm)' });
    // package.json in the exact dir wins over the go.mod two levels up.
    expect(result.language).toBe('typescript');
    expect(result.languageSource).toBe('package.json');
    expect(result.languageDir).toBe(dir);
  });

  it('attached HEAD reports repoRoot + branch', async () => {
    const dir = join(home, 'notes');
    const result = await inspectRepository(dir, {
      home,
      git: fakeGit({
        toplevel: { code: 0, out: `${dir}\n` },
        abbrevRef: { code: 0, out: 'main\n' },
      }),
    });
    expect(result.git).toBe(true);
    expect(result.repoRoot).toBe(dir);
    expect(result.branch).toBe('main');
    expect(result.detached).toBe(false);
    expect(result.head).toBeNull();
  });

  it('detached HEAD reports the short sha', async () => {
    const dir = join(home, 'notes');
    const result = await inspectRepository(dir, {
      home,
      git: fakeGit({
        toplevel: { code: 0, out: `${dir}\n` },
        abbrevRef: { code: 0, out: 'HEAD\n' },
        short: { code: 0, out: 'abc1234\n' },
      }),
    });
    expect(result.git).toBe(true);
    expect(result.branch).toBeNull();
    expect(result.detached).toBe(true);
    expect(result.head).toBe('abc1234');
  });

  it('dev is the run fallback when start is missing; no manifest → no suggestions', async () => {
    const dir = join(home, 'services', 'web');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
    const devOnly = await inspectRepository(dir, { home, git: fakeGit({ toplevel: { code: 1, out: '' } }) });
    expect(devOnly.run).toEqual({ command: 'npm run dev', source: 'package.json scripts.dev' });
    expect(devOnly.build).toBeNull();
    expect(devOnly.test).toBeNull();

    const bare = await inspectRepository(join(home, 'notes'), { home, git: fakeGit({ toplevel: { code: 1, out: '' } }) });
    expect(bare.build).toBeNull();
    expect(bare.run).toBeNull();
    expect(bare.test).toBeNull();
  });

  it('a missing directory never throws: git:false, no suggestions', async () => {
    const result = await inspectRepository(join(home, 'missing-xyz'), { home, git: fakeGit({ toplevel: { code: 128, out: '' } }) });
    expect(result.git).toBe(false);
    expect(result.build).toBeNull();
  });
});

/* — gateway dispatch (payload validation + envelope) — */

const stubDeps = { config: null, pool: null, engine: null, client: null } as unknown as RouteDeps;

describe('handleGatewayOperation discovery ops', () => {
  it('fs.browse with no path lists home under {ok,result}', async () => {
    const response = await handleGatewayOperation(stubDeps, 'fs.browse', {});
    expect(response.ok).toBe(true);
    const result = (response as { ok: true; result: { path: string; entries: string[] } }).result;
    expect(typeof result.path).toBe('string');
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it('fs.browse rejects a non-string path with a 400 (never throws)', async () => {
    const response = await handleGatewayOperation(stubDeps, 'fs.browse', { path: 42 });
    expect(response).toMatchObject({ ok: false, status: 400 });
  });

  it('repo.inspect requires the path and answers a missing dir as git:false', async () => {
    const invalid = await handleGatewayOperation(stubDeps, 'repo.inspect', {});
    expect(invalid).toMatchObject({ ok: false, status: 400 });

    const response = await handleGatewayOperation(stubDeps, 'repo.inspect', { path: join(home, 'notes') });
    expect(response.ok).toBe(true);
    const result = (response as { ok: true; result: { git: boolean; path: string } }).result;
    expect(result.git).toBe(false);
    expect(result.path).toBe(join(home, 'notes'));
  });

  it('unknown operations still answer 400', async () => {
    const response = await handleGatewayOperation(stubDeps, 'fs.nope', {});
    expect(response).toMatchObject({ ok: false, status: 400 });
  });
});
