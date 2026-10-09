import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';

/**
 * Folder browsing + repository inspection: the executor side of the
 * project form's path picker (the hub's `builder.fs.browse` /
 * `builder.repo.inspect`, served here as `/api/v1/fs/browse` and
 * `/api/v1/repo/inspect` over HTTP and as the `fs.browse` /
 * `repo.inspect` gateway operations — ONE implementation behind both,
 * mirroring the hub's own fs-browse.ts / repository-inspect.ts behavior
 * so the console renders one contract regardless of transport).
 *
 * Everything is read-only and bounded: listings are capped, git runs with
 * a timeout and an output bound, manifests are parsed never executed.
 */

/** Hard bound on the subdirectories one browse response carries. */
export const BROWSE_ENTRY_LIMIT = 300;
/** How far up a picked folder's ancestry language markers are sought. */
export const LANGUAGE_MARKER_DEPTH = 4;

export interface BrowseResult {
  probe: string;
  path: string;
  parent: string | null;
  exact: boolean;
  entries: string[];
  truncated: boolean;
  error: string | null;
  language: 'typescript' | 'go' | null;
  languageSource: string | null;
  languageDir: string | null;
}

export interface RepoCommandSuggestion { command: string; source: string }

export interface RepoInspection {
  path: string;
  git: boolean;
  repoRoot: string | null;
  branch: string | null;
  detached: boolean;
  head: string | null;
  language: 'typescript' | 'go' | null;
  languageSource: string | null;
  languageDir: string | null;
  build: RepoCommandSuggestion | null;
  run: RepoCommandSuggestion | null;
  test: RepoCommandSuggestion | null;
}

/* — Browsing (mirrors the hub's fs-browse.ts) — */

function listSubdirs(dir: string): { ok: true; entries: string[]; truncated: boolean } | { ok: false; error: string } {
  let names: string[];
  try {
    names = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        names.push(entry.name);
      } else if (entry.isSymbolicLink()) {
        try {
          if (statSync(join(dir, entry.name)).isDirectory()) names.push(entry.name);
        } catch { /* dangling — skip */ }
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, error: 'No such folder.' };
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'Permission denied.' };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : a > b ? 1 : 0));
  return { ok: true, entries: names.slice(0, BROWSE_ENTRY_LIMIT), truncated: names.length > BROWSE_ENTRY_LIMIT };
}

const LANGUAGE_MARKERS: readonly { file: string; language: 'typescript' | 'go' }[] = [
  { file: 'tsconfig.json', language: 'typescript' },
  { file: 'go.mod', language: 'go' },
  { file: 'package.json', language: 'typescript' },
];

function detectProjectLanguage(dir: string, home: string, exists: (path: string) => boolean): { language: 'typescript' | 'go'; source: string; dir: string } | null {
  let current = dir;
  for (let depth = 0; depth <= LANGUAGE_MARKER_DEPTH; depth += 1) {
    for (const marker of LANGUAGE_MARKERS) {
      if (exists(join(current, marker.file))) {
        return { language: marker.language, source: marker.file, dir: current };
      }
    }
    if (current === home) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** The whole browse: resolve the input (trailing slash = the dir itself),
 *  list its subdirectories, and detect the exact pick's language. */
export function browseFolders(rawInput: string, home: string = homedir()): BrowseResult {
  const raw = rawInput.trim();
  const drillsIn = raw === '' || raw === '~' || raw.endsWith('/');
  const expanded = raw === '~' || raw.startsWith('~/') ? home + raw.slice(1) : raw;
  let abs = expanded.startsWith('/') ? resolvePath(expanded) : resolvePath(home, expanded);
  while (abs.length > 1 && abs.endsWith('/')) abs = abs.slice(0, -1);
  const probe = abs;
  const listDir = drillsIn ? abs : dirname(abs);
  const listed = listSubdirs(listDir);
  let exact = false;
  try {
    exact = statSync(probe).isDirectory();
  } catch { /* missing — not exact */ }
  const detection = exact ? detectProjectLanguage(probe, home, (path) => { try { return statSync(path).isFile(); } catch { return false; } }) : null;
  return {
    probe,
    path: listDir,
    parent: listDir === '/' ? null : dirname(listDir),
    exact,
    entries: listed.ok ? listed.entries : [],
    truncated: listed.ok ? listed.truncated : false,
    error: listed.ok ? null : listed.error,
    language: detection?.language ?? null,
    languageSource: detection?.source ?? null,
    languageDir: detection?.dir ?? null,
  };
}

/* — Repository inspection (mirrors the hub's repository-inspect.ts) — */

export interface GitOutcome { code: number | null; stdout: string }
export type InspectGitRunner = (args: string[], cwd: string) => Promise<GitOutcome>;

function createGitRunner(timeoutMs: number): InspectGitRunner {
  return (args, cwd) => new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) {
        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null;
        resolve({ code, stdout: typeof stdout === 'string' ? stdout : '' });
        return;
      }
      resolve({ code: 0, stdout: typeof stdout === 'string' ? stdout : '' });
    });
  });
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

function detectPackageManager(dir: string, exists: (path: string) => boolean): PackageManager {
  if (exists(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (exists(join(dir, 'yarn.lock'))) return 'yarn';
  if (exists(join(dir, 'bun.lockb')) || exists(join(dir, 'bun.lock'))) return 'bun';
  return 'npm';
}

function scriptCommand(pm: PackageManager, script: string): string {
  return script === 'start' || script === 'test' ? `${pm} ${script}` : `${pm} run ${script}`;
}

function readManifestScripts(dir: string): { build?: string; start?: string; dev?: string; test?: string } {
  let raw: string;
  try {
    raw = readFileSync(join(dir, 'package.json'), 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const scripts = (parsed as Record<string, unknown>).scripts;
    if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return {};
    const values = scripts as Record<string, unknown>;
    const pick = (key: string) => typeof values[key] === 'string' && (values[key] as string).trim()
      ? (values[key] as string).trim()
      : undefined;
    return { build: pick('build'), start: pick('start'), dev: pick('dev'), test: pick('test') };
  } catch {
    return {};
  }
}

/** Inspect one exact directory: git facts + the repository's own declared
 *  commands + the marker-file language. Never throws. */
export async function inspectRepository(
  rawDir: string,
  options?: { home?: string; git?: InspectGitRunner; gitTimeoutMs?: number },
): Promise<RepoInspection> {
  const home = options?.home ?? homedir();
  const dir = rawDir.trim().replace(/\/+$/, '') || '/';
  const git = options?.git ?? createGitRunner(options?.gitTimeoutMs ?? 10_000);
  const exists = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

  const toplevel = await git(['rev-parse', '--show-toplevel'], dir);
  const isGit = toplevel.code === 0 && toplevel.stdout.trim().length > 0;
  const repoRoot = isGit ? toplevel.stdout.trim().split('\n')[0]! : null;

  let branch: string | null = null;
  let detached = false;
  let head: string | null = null;
  if (isGit) {
    const ref = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    const name = ref.code === 0 ? ref.stdout.trim() : '';
    if (name && name !== 'HEAD') {
      branch = name;
    } else {
      detached = true;
      const sha = await git(['rev-parse', '--short', 'HEAD'], dir);
      head = sha.code === 0 && sha.stdout.trim() ? sha.stdout.trim() : null;
    }
  }

  const detection = detectProjectLanguage(dir, home, exists);
  const manifestDir = detection?.dir ?? dir;
  const scripts = readManifestScripts(manifestDir);
  const pm = detectPackageManager(manifestDir, exists);
  const source = (script: string) => `package.json scripts.${script}${pm === 'npm' ? '' : ` (${pm})`}`;
  const declared = Object.keys(scripts).length > 0;
  return {
    path: dir,
    git: isGit,
    repoRoot,
    branch,
    detached,
    head,
    language: detection?.language ?? null,
    languageSource: detection?.source ?? null,
    languageDir: detection?.dir ?? null,
    build: declared && scripts.build ? { command: scriptCommand(pm, 'build'), source: source('build') } : null,
    run: declared && scripts.start
      ? { command: scriptCommand(pm, 'start'), source: source('start') }
      : declared && scripts.dev
        ? { command: scriptCommand(pm, 'dev'), source: source('dev') }
        : null,
    test: declared && scripts.test ? { command: scriptCommand(pm, 'test'), source: source('test') } : null,
  };
}
