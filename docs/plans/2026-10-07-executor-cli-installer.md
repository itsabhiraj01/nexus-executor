# Executor CLI, Headless Pairing Core & Installer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the executor into a real `nexus-executor` command with subcommands, a single headless pairing core shared by every frontend, a single CLI state file the running service reads at boot, and a `curl | bash` installer that provisions the machine then drives `nexus-executor pair`.

**Architecture:** npm `bin` CLI (`node:util` `parseArgs`, gateway transport default with `--hub` for direct). One headless `pair()` in `src/pairing/core.ts` shared by CLI/installer/later TUI. A single CLI state file (`~/.config/nexus-executor/state.json`) indexes transport/URL/name/status + a path to the real credential (gateway identity file or DB auth). The service reads this state at boot, deprecating env `PAIR_CODE` boot-pairing. `install.sh` provisions/link/systemd then calls `nexus-executor pair` (never owns pairing logic).

**Tech Stack:** TypeScript, node:util `parseArgs`, node:readline prompts, Fastify, pg, ws, pino, Vitest, bash `install.sh`. No new runtime deps — `parseArgs` and `node:readline` are built-in.

**Spec:** `docs/specs/2026-10-07-executor-cli-installer-design.md` (this worktree).

---

## File structure

```
bin/nexus-executor                package.json "bin" (thin, dynamic-imports src/cli/cli.js)
src/cli/cli.ts                    subcommand dispatch + parseArgs + exit codes + help
src/cli/pair.ts                   interactive + flags; gateway default
src/cli/status.ts                 read state + credential stores → human or --json
src/cli/unpair.ts                 two-step delete credential + clear state
src/cli/version.ts                print versions
src/cli/doctor.ts                 gateway/opencode/db/paired check; --json
src/cli/config.ts                 print effective config (state + .env)
src/cli/logs.ts                   tail journalctl or data/executor.log
src/cli/update.ts                 best-effort pull+build+restart
src/pairing/core.ts               headless pair() transport-agnostic
src/pairing/state.ts              CLI state file read/write/mark
src/pairing/prompts.ts            prompt() helper + confirm() (stub-able)
src/service/main.ts               MODIFY: read CLI state at boot (gateway + direct)
package.json                      MODIFY: add "bin"; scripts pair→cli
install.sh                        provision, link, systemd, run pair
README.md                         quickstart update
```

`src/pairing.ts` is retired (its logic moves into `src/pairing/core.ts`); `src/gateway.ts` `enrollGateway` stays but gains a write-state call in `src/pairing/core.ts`. The `service` boot reads `state.ts`.

---

## Tasks

### Task 1: `src/pairing/state.ts` — CLI state file

The single source the CLI and the service use to know transport/URL/name/status. It does NOT hold secrets — only an index pointing at the real credential (a FILE PATH for gateway identity, or the DB for direct). Store in `~/.config/nexus-executor/state.json` (overridable via `NEXUS_EXECUTOR_STATE` env for tests/containers).

**Files:**
- Create: `src/pairing/state.ts`
- Test: `src/pairing/state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/pairing/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCliState, writeCliState, clearCliState, type CliState } from './state.js';

function tmpState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-executor-state-'));
  const statePath = join(dir, 'state.json');
  process.env.NEXUS_EXECUTOR_STATE = statePath;
  return statePath;
}

function cleanup(): void {
  const p = process.env.NEXUS_EXECUTOR_STATE;
  if (p) rmSync(p.replace(/state\.json$/, ''), { recursive: true, force: true });
  delete process.env.NEXUS_EXECUTOR_STATE;
}

describe('cli state', () => {
  it('returns null when no state file exists', () => {
    tmpState();
    try {
      expect(readCliState()).toBeNull();
    } finally { cleanup(); }
  });

  it('round-trips a gateway state through write/read', () => {
    tmpState();
    try {
      const state: CliState = {
        transport: 'gateway',
        gatewayUrl: 'https://gateway.example.com',
        name: 'home-server',
        enrolledAt: '2026-10-07T00:00:00.000Z',
        identityPath: '/tmp/nexus-executor/data/gateway-identity.json',
      };
      writeCliState(state);
      expect(readCliState()).toEqual(state);
    } finally { cleanup(); }
  });

  it('clearCliState removes the file', () => {
    tmpState();
    try {
      writeCliState({ transport: 'direct', hubUrl: 'https://hub.example.com', name: 'x', pairedAt: '2026-10-07T00:00:00.000Z' });
      clearCliState();
      expect(readCliState()).toBeNull();
    } finally { cleanup(); }
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/pairing/state.test.ts`
Expected: FAIL — `./state.js` module not found.

- [ ] **Step 3: Implement `src/pairing/state.ts`**

Create `src/pairing/state.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type CliState =
  | { transport: 'gateway'; gatewayUrl: string; name: string; enrolledAt: string; identityPath: string }
  | { transport: 'direct'; hubUrl: string; name: string; pairedAt: string };

/** Path to the CLI state index. NEXUS_EXECUTOR_STATE overrides (tests/containers). */
export function cliStatePath(): string {
  return process.env.NEXUS_EXECUTOR_STATE
    ?? (process.env.HOME ? `${process.env.HOME}/.config/nexus-executor/state.json` : '');
}

export function readCliState(): CliState | null {
  const p = cliStatePath();
  if (!p || !existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as CliState;
  } catch {
    return null;
  }
}

export function writeCliState(state: CliState): void {
  const p = cliStatePath();
  if (!p) throw new Error('No CLI state path (HOME or NEXUS_EXECUTOR_STATE is unset).');
  mkdirSync(dirname(p), { recursive: true });
  // 0600: the index is not secret, but is sensitive config.
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function clearCliState(): void {
  const p = cliStatePath();
  if (p && existsSync(p)) rmSync(p, { force: true });
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run src/pairing/state.test.ts`
Expected: PASS (3).

- [ ] **Step 5: Commit**

```bash
git add src/pairing/state.ts src/pairing/state.test.ts
git commit -m "feat(executor): CLI pairing state file"
```

---

### Task 2: `src/pairing/prompts.ts` — prompt/confirm helpers

Minimal stdin prompt helper, injected so CLI tests can stub it. Uses `node:readline`.

**Files:**
- Create: `src/pairing/prompts.ts`
- Test: `src/pairing/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/pairing/prompts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { makePrompter } from './prompts.js';

describe('prompter', () => {
  it('prompts with the given question and returns the trimmed answer', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ask = makePrompter(input as never, output as never);
    const p = ask('Gateway URL?', 'https://default.example.com');
    input.write('https://gw.real.example.com\n');
    const answer = await p;
    expect(answer).toBe('https://gw.real.example.com');
  });

  it('returns the default when the user enters nothing', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ask = makePrompter(input as never, output as never);
    const p = ask('Gateway URL?', 'https://default.example.com');
    input.write('\n');
    expect(await p).toBe('https://default.example.com');
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/pairing/prompts.test.ts`
Expected: FAIL — `./prompts.js` not found.

- [ ] **Step 3: Implement `src/pairing/prompts.ts`**

Create `src/pairing/prompts.ts`:

```ts
import { createInterface, type Interface } from 'node:readline';
import { stdin as processStdin, stdout as processStdout } from 'node:process';

export type Prompter = (question: string, defaultValue?: string) => Promise<string>;

export function makePrompter(
  input = processStdin,
  output = processStdout,
): Prompter {
  const rl: Interface = createInterface({ input, output });
  const once = (q: string): Promise<string> => new Promise((resolve) => {
    rl.question(q, (answerRaw: string) => {
      const answer = answerRaw.trim();
      if (answer) resolve(answer);
      else resolve('');
    });
  });
  rl.on('close', () => { /* underlying stream owns lifecycle */ });
  return async (question: string, defaultValue?: string) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await once(`${question}${suffix} `);
    return answer || defaultValue ?? '';
  };
}
```

Note: `makePrompter(input, output)` returns a `Prompter`. In tests we pass `PassThrough` streams; in real use we pass the process streams. The returned function resolves empty string when no input, letting callers fall back to `defaultValue`.

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run src/pairing/prompts.test.ts`
Expected: PASS (2).

- [ ] **Step 5: Commit**

```bash
git add src/pairing/prompts.ts src/pairing/prompts.test.ts
git commit -m "feat(executor): interactive prompt helper"
```

---

### Task 3: `src/pairing/core.ts` — headless `pair()`

One top-level pairing function every frontend (CLI, installer, later TUI) calls. It resolves transport, calls the existing credential-producing logic, and writes the CLI state index. It never prompts — the caller resolves inputs first (CLI prompts/flags, installer flags) and passes a resolved `PairRequest`.

**Files:**
- Create: `src/pairing/core.ts`
- Test: `src/pairing/core.test.ts`

- [ ] **Step 1: Read the current `src/pairing.ts` and `src/gateway.ts`**

`claimPairing(config, pool, { fetchImpl })` (direct) POSTs `${config.hubUrl}/api/executors/pair` and stores the token hash in the DB `auth` config via `writeAuthConfig`. `enrollGateway(config, { fetchImpl })` (gateway) POSTs `{gatewayUrl}/v1/enroll` and writes `gateway-identity.json`. The new `pair()` composes both and writes the CLI state index. Read `src/pairing.ts` `claimPairing` and `src/gateway.ts` `enrollGateway` signatures first — the implementation below adapts to them.

- [ ] **Step 2: Write the failing test**

Create `src/pairing/core.test.ts`:

```ts
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pair } from './core.js';
import { readCliState } from './state.js';

function tmpEnv(): { dir: string; identityPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-executor-core-'));
  const identityPath = join(dir, 'gateway-identity.json');
  process.env.NEXUS_EXECUTOR_STATE = join(dir, 'config', 'state.json');
  process.env.GATEWAY_IDENTITY_PATH = identityPath;
  return { dir, identityPath };
}

afterEach(() => {
  const p = process.env.NEXUS_EXECUTOR_STATE;
  if (p) rmSync(p.replace(/\/state\.json$/, ''), { recursive: true, force: true });
  const ident = process.env.GATEWAY_IDENTITY_PATH;
  if (ident) rmSync(ident, { force: true });
  delete process.env.NEXUS_EXECUTOR_STATE;
  delete process.env.GATEWAY_IDENTITY_PATH;
});

function visitingGateway(): typeof fetch & { seenEnrollBody?: () => Record<string, unknown> | null } {
  let seen: Record<string, unknown> | null = null;
  const spy = async (url: unknown, init?: unknown) => {
    seen = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ credential: 'cred-abc', executorId: 'exec_01KXYZ' }));
  } as typeof fetch & { seenEnrollBody?: () => Record<string, unknown> | null };
  spy.seenEnrollBody = () => seen;
  return spy;
}

describe('pair() — gateway transport (default)', () => {
  it('enrolls via the gateway and writes CLI state', async () => {
    tmpEnv();
    const spy = visitingGateway();
    const result = await pair({
      transport: 'gateway',
      gatewayUrl: 'https://gateway.example.com',
      pairingCode: 'ABC123',
      executorName: 'home-server',
      fetchImpl: spy,
    });
    expect(result.transport).toBe('gateway');
    expect(result.executorId).toBe('exec_01KXYZ');
    expect(spy.seenEnrollBody?.()?.enrollment_token).toBe('ABC123');

    const state = readCliState();
    expect(state?.transport).toBe('gateway');
    expect((state as { gatewayUrl?: string }).gatewayUrl).toBe('https://gateway.example.com');
    expect((state as { name?: string }).name).toBe('home-server');
    expect(existsSync(process.env.GATEWAY_IDENTITY_PATH as string)).toBe(true);
  });

  it('throws a clear error when the gateway is unreachable and leaves state clean', async () => {
    tmpEnv();
    await expect(pair({
      transport: 'gateway',
      gatewayUrl: 'https://gateway.example.com',
      pairingCode: 'ABC123',
      executorName: 'x',
      fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch,
    })).rejects.toThrow(/gateway/i);
    expect(readCliState()).toBeNull();
    expect(existsSync(process.env.GATEWAY_IDENTITY_PATH as string)).toBe(false);
  });
});
```

- [ ] **Step 3: Run to confirm it fails**

Run: `npx vitest run src/pairing/core.test.ts`
Expected: FAIL — `./core.js` not found.

- [ ] **Step 4: Implement `src/pairing/core.ts`**

Create `src/pairing/core.ts`:

```ts
import { writeCliState } from './state.js';

export type PairTransport = 'gateway' | 'direct';

export interface PairRequest {
  transport: PairTransport;
  /** gateway transport */
  gatewayUrl?: string;
  /** direct transport */
  hubUrl?: string;
  pairingCode: string;
  executorName: string;
  fetchImpl?: typeof fetch;
}

export interface PairResult {
  transport: PairTransport;
  /** Gateway: the executor id issued by the hub. Direct: name (+ no id). */
  executorId?: string;
  name: string;
}

/**
 * Headless pairing — the ONLY place pairing is implemented. Callers resolve
 * inputs (prompt/flags); this resolves transport, produces/persists the
 * credential, and writes the CLI state index. Never prompts; never owns UI.
 */
export async function pair(req: PairRequest): Promise<PairResult> {
  if (req.transport === 'gateway') {
    const code = req.pairingCode.trim().toUpperCase();
    if (!code) throw new Error('A pairing code is required.');
    const gatewayUrl = (req.gatewayUrl ?? '').trim().replace(/\/+$/, '');
    if (!gatewayUrl) throw new Error('A gateway URL is required for gateway pairing.');
    const { enrollGateway } = await import('../gateway.js');
    try {
      const identity = await enrollGateway(
        { gatewayUrl, pairCode: code, executorName: req.executorName } as never,
        { fetchImpl: req.fetchImpl },
      );
      const identityPath = process.env.GATEWAY_IDENTITY_PATH ?? '';
      await writeCliState({
        transport: 'gateway',
        gatewayUrl,
        name: req.executorName,
        enrolledAt: 'enrolledAt' in identity
          ? (identity as unknown as { enrolledAt: string }).enrolledAt
          : new Date().toISOString(),
        identityPath,
      });
      return { transport: 'gateway', executorId: (identity as unknown as { executorId: string }).executorId, name: req.executorName };
    } catch (error) {
      throw new Error(`Gateway pairing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Direct transport.
  const hubUrl = (req.hubUrl ?? '').trim().replace(/\/+$/, '');
  if (!hubUrl) throw new Error('A hub URL is required for direct pairing (or leave it unset for gateway).');
  try {
    const { claimPairing } = await import('../pairing.js');
    const { createPool } = await import('../db.js');
    const pool = createPool(process.env.DATABASE_URL ?? '');
    try {
      const outcome = await claimPairing(
        { hubUrl, pairCode: req.pairingCode, executorName: req.executorName, publicUrl: process.env.EXECUTOR_PUBLIC_URL ?? '' } as never,
        pool,
        { fetchImpl: req.fetchImpl },
      );
      if (!outcome.alreadyPaired) {
        await writeCliState({ transport: 'direct', hubUrl, name: outcome.name ?? req.executorName, pairedAt: new Date().toISOString() });
      }
      return { transport: 'direct', name: outcome.name ?? req.executorName };
    } finally {
      await pool.end().catch(() => {});
    }
  } catch (error) {
    throw new Error(`Direct pairing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

> **Implementer note:** `enrollGateway` and `claimPairing` expect fuller config shapes. The `as never` casts adapt call sites; prefer threading the exact fields those functions need rather than relying on casts if it's clean to do so. `enrollGateway` needs `gatewayUrl` + `pairCode` (and uses `EXECUTOR_VERSION` internally); `claimPairing` needs `hubUrl` + `pairCode` + `executorName` + `publicUrl`. Adjust the casts to satisfy the real signatures and re-run the test.

- [ ] **Step 5: Run to confirm it passes**

Run: `npx vitest run src/pairing/core.test.ts`
Expected: PASS (2). Adjust env/casts per the implementer note if signatures differ.

- [ ] **Step 6: Commit**

```bash
git add src/pairing/core.ts src/pairing/core.test.ts
git commit -m "feat(executor): headless pairing core"
```

---

### Task 4: `bin/nexus-executor` + `src/cli/cli.ts` — subcommand dispatch

The `nexus-executor` entry. The bin is a thin launcher that dynamic-imports the compiled `src/cli/cli.js`; `cli.ts` parses the first arg as the subcommand, prints help for the bare command (a compact status summary), and delegates.

**Files:**
- Create: `bin/nexus-executor`
- Create: `src/cli/cli.ts`
- Test: `src/cli/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/cli.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCli } from './cli.js';

describe('nexus-executor dispatch', () => {
  it('prints help for an unknown subcommand and exits non-zero', async () => {
    let code = 0;
    const out = await runCli(['frobnicate'], { exit: (c) => { code = c; } });
    expect(out).toContain('Usage');
    expect(code).toBe(2);
  });

  it('prints version for `version`', async () => {
    const out = await runCli(['version']);
    expect(out).toMatch(/^nexus-executor v?/);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/cli/cli.test.ts`
Expected: FAIL — `./cli.js` not found.

- [ ] **Step 3: Implement `src/cli/cli.ts`**

Create `src/cli/cli.ts`:

```ts
import { EXECUTOR_VERSION } from '../config.js';

export interface CliRunOptions {
  exit?: (code: number) => void;
  stdout?: (text: string) => void;
}

const HELP = `nexus-executor — Nexus executor control

Usage:
  nexus-executor                show status summary
  nexus-executor pair           pair/enroll this executor (interactive)
  nexus-executor unpair         remove pairing (two-step on a live machine)
  nexus-executor status         show pairing + runtime status  (--json)
  nexus-executor version        print versions
  nexus-executor doctor         self-check connectivity        (--json)
  nexus-executor config         print effective config
  nexus-executor logs           tail the service log
  nexus-executor update         pull, build, restart (best-effort)
  nexus-executor help           show this help

Run 'nexus-executor <cmd> --help' for flags.
`;

export async function runCli(
  argv: string[],
  opts: CliRunOptions = {},
): Promise<string> {
  const print = opts.stdout ?? ((t: string) => process.stdout.write(t + '\n'));
  const exit = opts.exit ?? ((code: number) => { process.exitCode = code; });
  const [command, ...rest] = argv;

  switch (command) {
    case 'version': {
      const text = `nexus-executor v${EXECUTOR_VERSION}`;
      print(text);
      return text;
    }
    case 'help': {
      print(HELP);
      return HELP;
    }
    case 'pair':
    case 'unpair':
    case 'status':
    case 'doctor':
    case 'config':
    case 'logs':
    case 'update':
      // Delegated in the subcommand tasks; these are stubbed here and
      // wired by later tasks.
      print(`TODO: ${command}`);
      return `TODO: ${command}`;
    default:
      print(HELP);
      exit(2);
      return HELP;
  }
}
```

> **Implementer note:** this is the MVP dispatch. Later tasks (5–9) replace the `TODO: <cmd>` stubs with real imports: `pair`, `unpair`, `status`, `doctor`, `config`, `logs`, `update`. A bare `nexus-executor` (empty args) shows a status summary — wire that in Task 7 where `status` exists. The `exit`/`stdout` options make it testable without spawning a process.

- [ ] **Step 4: Create `bin/nexus-executor`**

Create `bin/nexus-executor`:

```js
#!/usr/bin/env node
import('../dist/cli/cli.js').then(async ({ runCli }) => {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
```

Make it executable: `chmod +x bin/nexus-executor`.

- [ ] **Step 5: Run to confirm it passes**

Run: `npx vitest run src/cli/cli.test.ts`
Expected: PASS (2). The `version` path returns a matching string; the unknown-command path sets exit code 2 and prints help (the test stub returns the captured output).

- [ ] **Step 6: Commit**

```bash
git add src/cli/cli.ts src/cli/cli.test.ts bin/nexus-executor
git commit -m "feat(executor): nexus-executor subcommand dispatch"
```

---

### Task 5: `src/cli/pair.ts` — interactive + flags pair subcommand

Wires the headless `pair()` to the CLI: resolves transport (gateway default; `--hub` opts into direct), resolves gateway URL + pairing code (flag > env > prompt), and prints a result. Non-interactive (all flags/env set, or `--non-interactive`) does not prompt.

**Files:**
- Create: `src/cli/pair.ts`
- Test: `src/cli/pair.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/pair.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairFromCli } from './pair.js';

function tmpState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-executor-pair-'));
  const p = join(dir, 'state.json');
  process.env.NEXUS_EXECUTOR_STATE = p;
  return dir;
}

function clean(dir: string): void { rmSync(dir, { recursive: true, force: true }); delete process.env.NEXUS_EXECUTOR_STATE; }

describe('pairFromCli — gateway default, flags', () => {
  it('pairs with a gateway URL + code from flags without prompting', async () => {
    const dir = tmpState();
    process.env.GATEWAY_IDENTITY_PATH = join(dir, 'gw-identity.json');
    try {
      let hit = false;
      const result = await pairFromCli({
        argv: ['--gateway', 'https://gateway.example.com', '--code', 'ABC123'],
        fetchImpl: (async (_url, init) => new Response(JSON.stringify({ credential: 'c', executorId: 'exec_1' }))) as typeof fetch,
        onPair: async () => { hit = true; },
      });
      expect(result.transport).toBe('gateway');
      expect(hit).toBe(true);
    } finally { clean(dir); }
  });

  it('prompts for a pairing code when none is given', async () => {
    const dir = tmpState();
    process.env.GATEWAY_IDENTITY_PATH = join(dir, 'gw-identity.json');
    try {
      const result = await pairFromCli({
        argv: ['--gateway', 'https://gateway.example.com'],
        fetchImpl: (async (_url, init) => new Response(JSON.stringify({ credential: 'c', executorId: 'exec_1' }))) as typeof fetch,
        prompt: async () => 'ABC123',
      });
      expect(result.pairingCode).toBe('ABC123');
    } finally { clean(dir); }
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/cli/pair.test.ts`
Expected: FAIL — `./pair.js` not found.

- [ ] **Step 3: Implement `src/cli/pair.ts`**

Create `src/cli/pair.ts`:

```ts
import { parseArgs } from 'node:util';
import { pair, type PairResult } from '../pairing/core.js';
import { makePrompter, type Prompter } from '../pairing/prompts.js';

export interface PairCliOptions {
  argv: string[];
  /** injectable fetch (tests) */
  fetchImpl?: typeof fetch;
  /** injectable prompter (defaults to real stdin/stdout) */
  prompt?: Prompter;
  /** hook called on a successful pair (tests assert it) */
  onPair?: (result: PairResult) => void;
  /** default gateway URL shown in the prompt */
  defaultGatewayUrl?: string;
}

export interface PairCliResult extends PairResult {
  pairingCode: string;
}

export async function pairFromCli(opts: PairCliOptions): Promise<PairCliResult> {
  const { values } = parseArgs({
    args: opts.argv,
    allowPositionals: true,
    options: {
      gateway: { type: 'string' },
      hub: { type: 'string' },
      code: { type: 'string' },
      name: { type: 'string' },
      'non-interactive': { type: 'boolean', short: 'y' },
    },
  });

  const interaction = opts.prompt ?? makePrompter();
  const gatewayUrl = values.gateway ?? process.env.GATEWAY_URL?.trim() ?? (await interaction('Gateway URL', opts.defaultGatewayUrl ?? 'https://gateway.example.com'));
  const hubUrl = values.hub ?? process.env.HUB_URL?.trim() ?? undefined;
  const transport = hubUrl ? 'direct' : 'gateway';
  const pairingCode = values.code ?? process.env.PAIR_CODE?.trim() ?? (await interaction('Pairing code'));
  const executorName = values.name ?? process.env.EXECUTOR_NAME?.trim() ?? process.env.HOSTNAME ?? 'executor';

  const result = await pair({
    transport,
    gatewayUrl,
    hubUrl,
    pairingCode,
    executorName,
    fetchImpl: opts.fetchImpl,
  });
  if (opts.onPair) opts.onPair(result);
  return { ...result, pairingCode };
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run src/cli/pair.test.ts`
Expected: PASS (2). Fix the test's stray `afterCleanup:` label first if it's still in the file (remove it — it was accidentally left in the snippet).

- [ ] **Step 5: Commit**

```bash
git add src/cli/pair.ts src/cli/pair.test.ts
git commit -m "feat(executor): interactive + flag-based pair subcommand"
```

---

### Task 6: `src/service/main.ts` — boot reads CLI state, deprecate env boot-pair

The service reads the CLI state index at boot to determine transport + enrollment, instead of the `EXECUTOR_TRANSPORT` env gate + env `PAIR_CODE` boot-pair. Backward-compatible: when no CLI state exists, fall back to the existing env-driven path (so the containerized quickstart and legacy `.env` still work until they run `nexus-executor pair`).

**Files:**
- Modify: `src/main.ts` (lines ~1-80: the config → transport selection → pair/enroll block)
- Test: `src/main.test.ts` (may not exist — add boot-pairing tests there, or a focused unit test on a new `selectTransport(state, config)` helper)

- [ ] **Step 1: Read the current `src/main.ts` boot block**

Lines 1–80: it builds `config`, then branches `config.transport === 'gateway'` (calls `enrollGateway` + `runGatewayLoop`) or the direct path (`pairCode` → `claimPairing`, then the HTTP listener).

- [ ] **Step 2: Add a transport-selection helper in `src/pairing/core.ts`**

Add to `src/pairing/core.ts`:

```ts
import { readCliState } from './state.js';

/**
 * Pick the transport for the running service. CLI state wins; otherwise
 * fall back to the env's EXECUTOR_TRANSPORT (legacy/containerized). Returns
 * 'gateway' | 'direct'.
 */
export function selectTransport(envTransport?: string, stateTransport?: 'gateway' | 'direct' | null): 'gateway' | 'direct' {
  if (stateTransport === 'gateway' || stateTransport === 'direct') return stateTransport;
  return envTransport === 'gateway' ? 'gateway' : 'direct';
}
```

- [ ] **Step 3: Add a test for `selectTransport`**

Append to `src/pairing/core.test.ts`:

```ts
import { selectTransport } from './core.js';

it('prefers CLI state over env for transport selection', () => {
  expect(selectTransport('direct', 'gateway')).toBe('gateway');
  expect(selectTransport('gateway', 'direct')).toBe('direct');
  expect(selectTransport('gateway', null)).toBe('gateway');
  expect(selectTransport(undefined, null)).toBe('direct'); // default is direct-only when no state & no env incoming
});
```

Run: `npx vitest run src/pairing/core.test.ts` — PASS.

- [ ] **Step 4: Modify `src/main.ts` to read CLI state at boot**

At the top of the boot path (after `loadConfig()`), add:

```ts
import { readCliState } from './pairing/state.js';
import { selectTransport } from './pairing/core.js';
```

Then, before the transport branch, compute the effective transport and pass the CLI state through:

```ts
const cliState = readCliState();
const transport = selectTransport(config.transport, cliState?.transport ?? null);
```

Replace `config.transport === 'gateway'` with `transport === 'gateway'`. In the gateway branch, if `cliState` provides `gatewayUrl` / `pairCode` that the env lacks, use them for the `enrollGateway` call (the CLI state is the authoritative pairing source). In the direct branch, if `cliState` is present and paired, skip the env `pairCode` boot-pair (the service is already paired via the CLI).

Concretely, the gateway branch becomes (using the CLI state for the enroll call):

```ts
if (transport === 'gateway') {
  const { enrollGateway, runGatewayLoop } = await import('./gateway.js');
  const enrollConfig = {
    ...(config as unknown as Record<string, unknown>),
    gatewayUrl: cliState && 'gatewayUrl' in cliState ? cliState.gatewayUrl : config.gatewayUrl,
    pairCode: cliState ? cliState.pairCode ?? process.env.PAIR_CODE?.trim() : process.env.PAIR_CODE?.trim(),
  } as unknown as typeof config;
  const identity = await enrollGateway(enrollConfig);
  logger.info({ executorId: identity.executorId }, 'enrolled with gateway');
  // ... unchanged runGatewayLoop wiring
  return;
}
```

And the direct branch skips boot-pair when already paired via CLI state:

```ts
const alreadyViaCli = cliState && cliState.transport === 'direct';
if (!alreadyViaCli && config.pairCode && !(await readAuthConfig(pool))) {
  const outcome = await claimPairing(config, pool);
  logger.info(...);
}
```

> **Implementer note:** the type casts above adapt the existing `config` shape. Keep the diff focused. The key behavioral change: the service trusts the CLI state over env for transport and pairing input, and no longer auto-pairs at boot when the CLI already paired it.

- [ ] **Step 5: Run the executor test suite**

Run: `npx vitest run`
Expected: existing tests still pass (the boot change is additive; existing tests exercise `claimPairing`/`enrollGateway` via direct helpers). Fix any import breakage.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts src/pairing/core.ts src/pairing/core.test.ts
git commit -m "feat(executor): service reads CLI pairing state at boot"
```

---

### Task 7: `src/cli/status.ts` — status (+ `--json`)

Reports pairing + runtime status from the CLI state index and the credential store. First-run (no state) prints a helpful "not paired" message.

**Files:**
- Create: `src/cli/status.ts`
- Test: `src/cli/status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/cli/status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusFromCli } from './status.js';

function env(dir: string): void {
  process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
  process.env.GATEWAY_IDENTITY_PATH = join(dir, 'gw-identity.json');
}

describe('statusFromCli', () => {
  it('reports not paired when there is no state file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-status-'));
    env(dir);
    try {
      const out = await statusFromCli({ argv: [] });
      expect(out).toContain('not paired');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports gateway-enrolled with --json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-status-'));
    env(dir);
    try {
      process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
      const { writeCliState } = await import('../pairing/state.js');
      writeCliState({ transport: 'gateway', gatewayUrl: 'https://gw.example.com', name: 'box', enrolledAt: '2026-10-07T00:00:00.000Z', identityPath: join(dir, 'gw-identity.json') });
      const out = await statusFromCli({ argv: ['--json'] });
      const parsed = JSON.parse(out);
      expect(parsed.transport).toBe('gateway');
      expect(parsed.name).toBe('box');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `npx vitest run src/cli/status.test.ts`
Expected: FAIL — `./status.js` not found.

- [ ] **Step 3: Implement `src/cli/status.ts`**

Create `src/cli/status.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readCliState } from '../pairing/state.js';
import { EXECUTOR_VERSION } from '../config.js';

export interface StatusCliOptions { argv: string[] }

export async function statusFromCli(opts: StatusCliOptions): Promise<string> {
  const { values } = parseArgs({ args: opts.argv, options: { json: { type: 'boolean', short: 'j' } } });
  const state = readCliState();

  const base = {
    transport: state?.transport ?? null,
    name: state?.name ?? null,
    version: EXECUTOR_VERSION,
  };

  if (!state) {
    const text = `nexus-executor v${EXECUTOR_VERSION} — not paired (run \`nexus-executor pair\`)`;
    return values.json ? JSON.stringify({ ...base, paired: false, message: 'not paired' }) : text;
  }

  if (state.transport === 'gateway') {
    // Credential present iff the identity file exists.
    const identityPath = state.identityPath;
    const hasIdentity = identityPath ? existsSync(identityPath) : false;
    const gatewayOk = hasIdentity; // a full liveness check lives in `doctor`
    const report = { ...base, paired: true, enrolled: hasIdentity, gatewayOk, identityPath: identityPath ?? null, pairedAt: state.enrolledAt };
    return values.json ? JSON.stringify(report) : statusText(report);
  }

  const report = { ...base, paired: true, hubUrl: state.hubUrl, pairedAt: state.pairedAt };
  return values.json ? JSON.stringify(report) : statusText(report);
}

function statusText(r: Record<string, unknown>): string {
  return [
    `Executor:  ${r.name ?? '—'}`,
    `Transport: ${r.transport ?? '—'}`,
    `Version:   ${r.version ?? '—'}`,
    r.enrolled === false ? 'Enrolled:  no (identity file missing — run nexus-executor pair)' : `Enrolled:  yes`,
    r.gatewayUrl ? `Gateway:   ${r.gatewayUrl}` : '',
    r.hubUrl ? `Hub:       ${r.hubUrl}` : '',
    r.pairedAt ? `Paired:    ${r.pairedAt}` : '',
    r.gatewayOk === false ? 'Gateway:   no live session (run nexus-executor doctor)' : '',
  ].filter(Boolean).join('\n');
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `npx vitest run src/cli/status.test.ts`
Expected: PASS (2).

- [ ] **Step 5: Wire the bare `nexus-executor` command to status**

In `src/cli/cli.ts`, replace the `default:` unknown-command branch with a `status`-based bare command. When `argv` is empty (`command === undefined`), call `statusFromCli({ argv: [] })` and print it; keep the unknown-command help + exit-2 path for anything not recognized:

```ts
  if (!command) {
    const { statusFromCli } = await import('./status.js');
    const text = await statusFromCli({ argv: [] });
    print(text);
    return text;
  }
  switch (command) { ... }
```

Put this before the switch. Update `src/cli/cli.test.ts` to assert the bare command reports status (add: `it('prints status summary for a bare invocation' ...)`).

- [ ] **Step 6: Run the cli tests**

Run: `npx vitest run src/cli/cli.test.ts src/cli/status.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/status.ts src/cli/status.test.ts src/cli/cli.ts src/cli/cli.test.ts
git commit -m "feat(executor): status subcommand (human + --json)"
```

---

### Task 8: `version`, `unpair`, `doctor` subcommands

Small, focused subcommands. `unpair` is destructive (two-step on a live machine); `doctor` is the operator's "why is it down" checker.

**Files:**
- Create: `src/cli/version.ts`, `src/cli/unpair.ts`, `src/cli/doctor.ts`
- Test: `src/cli/version.test.ts`, `src/cli/unpair.test.ts`, `src/cli/doctor.test.ts`
- Modify: `src/cli/cli.ts` wiring

- [ ] **Step 1: Write `version` + test**

Create `src/cli/version.ts`:

```ts
import { EXECUTOR_VERSION } from '../config.js';
import { GATEWAY_PROTOCOL_VERSION } from '../gateway.js';

export function versionText(): string {
  return `nexus-executor v${EXECUTOR_VERSION}\nprotocol ${GATEWAY_PROTOCOL_VERSION}`;
}
```

Create `src/cli/version.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { versionText } from './version.js';

describe('versionText', () => {
  it('reports the executor and protocol versions', () => {
    expect(versionText()).toMatch(/^nexus-executor v\d+\.\d+\.\d+/);
    expect(versionText()).toContain('protocol');
  });
});
```

- [ ] **Step 2: Write `unpair` + test**

Create `src/cli/unpair.ts`:

```ts
import { existsSync, rmSync } from 'node:fs';
import { clearCliState, readCliState } from '../pairing/state.js';
import { makePrompter } from '../pairing/prompts.js';

export interface UnpairOptions {
  argv: string[];
  prompt?: (q: string) => Promise<string>;
  // allow tests to bypass the confirmation
  force?: boolean;
}

export async function unpair(opts: UnpairOptions): Promise<string> {
  const state = readCliState();
  if (!state) return 'Not paired — nothing to unpair.';
  const force = opts.force || opts.argv.includes('--force');
  if (!force) {
    const ask = opts.prompt ?? makePrompter();
    const answer = await ask(`Really unpair "${state.name}" from ${state.transport}? This cannot be undone. Type the executor name to confirm:`);
    if (answer.trim() !== state.name) return 'Aborted — name did not match.';
  }
  // Remove the credential:
  if (state.transport === 'gateway') {
    const p = state.identityPath;
    if (p && existsSync(p)) rmSync(p, { force: true });
  }
  clearCliState();
  return `Unpaired "${state.name}". Run \`nexus-executor pair\` to re-pair.`;
}
```

Create `src/cli/unpair.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCliState } from '../pairing/state.js';
import { unpair } from './unpair.js';

describe('unpair', () => {
  it('removes the identity and state when confirmed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-unpair-'));
    const identity = join(dir, 'gw.json');
    process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
    writeCliState({ transport: 'gateway', gatewayUrl: 'https://g', name: 'box', enrolledAt: '2026-10-07T00:00:00.000Z', identityPath: identity });
    writeFileSync(identity, '{}');
    try {
      const out = await unpair({ argv: [], force: true });
      expect(out).toContain('Unpaired');
      expect(existsSync(identity)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 3: Write `doctor` + test**

Create `src/cli/doctor.ts`:

```ts
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { readCliState } from '../pairing/state.js';
import { EXECUTOR_VERSION } from '../config.js';

export interface DoctorResult {
  paired: boolean;
  transport: 'gateway' | 'direct' | null;
  name: string | null;
  version: string;
  identityPresent: boolean;
  notes: string[];
}

export async function doctor(opts: { argv: string[] }): Promise<string> {
  const { values } = parseArgs({ args: opts.argv, options: { json: { type: 'boolean', short: 'j' } } });
  const state = readCliState();
  const notes: string[] = [];
  const identity = state?.transport === 'gateway' && state.identityPath ? existsSync(state.identityPath) : state ? true : false;
  if (!state) notes.push('not paired — run `nexus-executor pair`');
  else if (state.transport === 'gateway' && identity) notes.push('gateway identity present');
  else if (state.transport === 'gateway' && !identity) notes.push('gateway identity MISSING — re-run `nexus-executor pair`');
  else notes.push('direct transport (token lives in the DB)');

  const result: DoctorResult = {
    paired: !!state,
    transport: state?.transport ?? null,
    name: state?.name ?? null,
    version: EXECUTOR_VERSION,
    identityPresent: identity,
    notes,
  };
  return values.json ? JSON.stringify(result, null, 2) : printDoctor(result);
}

function printDoctor(r: DoctorResult): string {
  return [
    `Paired:      ${r.paired ? 'yes' : 'no'}`,
    `Transport:   ${r.transport ?? '—'}`,
    `Name:        ${r.name ?? '—'}`,
    `Version:     ${r.version}`,
    `Identity:    ${r.identityPresent ? 'present' : 'missing'}`,
    ...r.notes.map((n) => `  · ${n}`),
  ].join('\n');
}
```

Create `src/cli/doctor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from './doctor.js';

describe('doctor', () => {
  it('reports not paired when no state exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nx-doctor-'));
    process.env.NEXUS_EXECUTOR_STATE = join(dir, 'state.json');
    try {
      const out = await doctor({ argv: ['--json'] });
      const r = JSON.parse(out);
      expect(r.paired).toBe(false);
      expect(r.notes.some((n: string) => n.includes('not paired'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

> **Implementer note:** this `doctor` is a minimal v1 (identity presence + paired). Extending it to live gateway/opencode/DB liveness (per the spec) is a natural follow-up that belongs in a later task/pass — keep this task's box small and green.

- [ ] **Step 4: Wire `version`/`unpair`/`doctor` into the dispatch**

In `src/cli/cli.ts`, replace the `TODO: <cmd>` stubs for `version`, `unpair`, `doctor` with real calls:

```ts
  case 'version': {
    const { versionText } = await import('./version.js');
    print(versionText());
    return versionText();
  }
  case 'unpair': {
    const { unpair } = await import('./unpair.js');
    const text = await unpair({ argv: rest });
    print(text);
    return text;
  }
  case 'doctor': {
    const { doctor } = await import('./doctor.js');
    const text = await doctor({ argv: rest });
    print(text);
    return text;
  }
```

Keep `pair`, `status`, `config`, `logs`, `update` wired as before (pair/status already; config/logs/update in Task 9).

- [ ] **Step 5: Run the cli + subcommand tests**

Run: `npx vitest run src/cli/cli.test.ts src/cli/version.test.ts src/cli/unpair.test.ts src/cli/doctor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/version.ts src/cli/version.test.ts src/cli/unpair.ts src/cli/unpair.test.ts src/cli/doctor.ts src/cli/doctor.test.ts src/cli/cli.ts src/cli/cli.test.ts
git commit -m "feat(executor): version, unpair, doctor subcommands"
```

---

### Task 9: `config`, `logs`, `update` subcommands (thin, best-effort)

Deliberately minimal. `config` prints the effective config (state + key env); `logs` tails the service log; `update` is a best-effort pull+build+restart with a guard against running in a non-git tree.

**Files:**
- Create: `src/cli/config.ts`, `src/cli/logs.ts`, `src/cli/update.ts`

- [ ] **Step 1: Implement `config`**

Create `src/cli/config.ts`:

```ts
import { readCliState } from '../pairing/state.js';

export function configText(): string {
  const state = readCliState();
  const rows: string[] = ['Executor config:', `  transport   = ${state?.transport ?? '(not set)'}`];
  if (state && 'gatewayUrl' in state) rows.push(`  gatewayUrl  = ${state.gatewayUrl}`);
  if (state && 'hubUrl' in state) rows.push(`  hubUrl      = ${state.hubUrl}`);
  rows.push(`  name        = ${state?.name ?? '(not set)'}`);
  ['DATABASE_URL', 'GATEWAY_URL', 'EXECUTOR_TRANSPORT', 'EXECUTOR_PUBLIC_URL', 'OPENCODE_BASE_URL'].forEach((k) => {
    const v = process.env[k];
    rows.push(`  ${k}        = ${v ? 'set' : '(unset)'}`);
  });
  return rows.join('\n');
}
```

(mask secrets: `DATABASE_URL`/`GATEWAY_URL` are printed as `set`/`(unset)`, never their value.)

- [ ] **Step 2: Implement `logs`**

Create `src/cli/logs.ts`:

```ts
import { spawn } from 'node:child_process';

export function tailLogs(opts: { argv: string[]; lines?: number }): void {
  const lines = opts.lines ?? 50;
  // systemd-managed installs log to the journal; otherwise a local file.
  const logFile = process.env.EXECUTOR_LOG_FILE;
  const cmd = logFile
    ? ['tail', '-n', String(lines), '-f', logFile]
    : ['journalctl', '-u', 'nexus-executor', '-n', String(lines), '-f'];
  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  child.on('error', (err) => {
    console.error(`logs: could not run ${cmd[0]}: ${err.message}`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 3: Implement `update`**

Create `src/cli/update.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export function update(): string {
  if (!existsSync('.git')) {
    return 'update: not a git checkout (nothing to pull) — rebuild via the installed package manager.';
  }
  execFileSync('git', ['pull', '--ff-only'], { stdio: 'inherit' });
  execFileSync('npm', ['install'], { stdio: 'inherit' });
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  return 'update: rebuilt — restart the service (systemctl --user restart nexus-executor).';
}
```

> **Implementer note:** `update` is intentionally best-effort and non-destructive (ff-only pull, no data touched). It returns a hint, not an auto-restart, so the operator controls the restart. Wire it into `cli.ts`'s `update` case as a plain call + print.

- [ ] **Step 4: Wire `config`/`logs`/`update` into the dispatch**

In `src/cli/cli.ts`, add for `config`:

```ts
  case 'config': {
    const { configText } = await import('./config.js');
    print(configText());
    return configText();
  }
```

For `logs` (fire-and-forget tail — no stdout return), call `tailLogs({ argv: rest })` and return `''`. For `update`, call `update()` and print the returned string. Replace all remaining `TODO: <cmd>` stubs so no subcommand is left unimplemented.

- [ ] **Step 5: Run the full executor test suite**

Run: `npx vitest run`
Expected: PASS (all prior + new). Confirm no `TODO:` dispatch paths remain in `cli.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/config.ts src/cli/logs.ts src/cli/update.ts src/cli/cli.ts
git commit -m "feat(executor): config, logs, update subcommands"
```

---

### Task 10: `install.sh` — provision, link, systemd, pair

A `curl | bash` installer. It builds + links `nexus-executor`, writes a systemd unit, and invokes `nexus-executor pair` (interactive or via flags/env). It never implements pairing itself — it calls the CLI.

**Files:**
- Create: `install.sh`

- [ ] **Step 1: Write `install.sh`**

Create `install.sh` at the repo root:

```bash
#!/usr/bin/env bash
# Nexus Executor installer.
#   curl -fsSL https://executor.example.com/install | bash
#   curl -fsSL ... | bash -s -- --gateway https://gateway.example.com --code ABC123
set -euo pipefail

GATEWAY=""
CODE=""
DRY_RUN=0

usage() { echo "Usage: install.sh [--gateway URL] [--code CODE] [--dry-run]"; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway) GATEWAY="${2:-}"; shift 2 ;;
    --code)    CODE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) usage ;;
  esac
done

step() { echo; echo "→ $*"; }
run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then echo "   (dry-run) $*"; else "$@"; fi
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "Dry-run mode — no changes will be made."
fi

step "Building & installing nexus-executor"
run npx --yes ci
run npm run build
run npm link

step "Writing systemd unit (nexus-executor.service)"
UNIT_DIR="${HOME}/.config/systemd/user"
run mkdir -p "$UNIT_DIR"
cat <<'UNIT' | run tee "$UNIT_DIR/nexus-executor.service" >/dev/null
[Unit]
Description=Nexus Executor
After=network-online.target

[Service]
ExecStart=/usr/bin/env node "$(pwd)/dist/main.js"
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
UNIT

if [[ "$DRY_RUN" -eq 1 ]]; then
  step "Done (dry-run)."
  exit 0
fi

systemctl --user daemon-reload
systemctl --user enable --now nexus-executor

step "Pairing this machine"
PAIR_CMD=(nexus-executor pair)
[[ -n "$GATEWAY" ]] && PAIR_CMD+=(--gateway "$GATEWAY")
[[ -n "$CODE" ]] && PAIR_CMD+=(--code "$CODE")
"${PAIR_CMD[@]}"

echo
echo "Installed. Status:"
nexus-executor status
```

Make it executable: `chmod +x install.sh`.

> **Implementer note:** the systemd unit above inlines `"$(pwd)/dist/main.js"` which is evaluated when the unit file is written. Use the absolute path of the checkout for a stable unit. If `npm link` isn't available in the runtime, install `dist` via `npm i -g` instead. Keep the pairing call delegated to `nexus-executor pair` — no pairing HTTP in the installer.

- [ ] **Step 2: Shellcheck pass**

Run: `shellcheck install.sh` (if available) or `bash -n install.sh`
Expected: no syntax errors; address any `shellcheck` warnings you can.

- [ ] **Step 3: Dry-run smoke**

Run: `bash install.sh --dry-run --gateway https://g.example.com --code ABC`
Expected: prints "Dry-run mode" and the `run` lines with `(dry-run)` prefixes; exits 0 without writing files or invoking the network.

- [ ] **Step 4: Commit**

```bash
git add install.sh
git commit -m "feat(executor): curl|bash installer"
```

---

### Task 11: `package.json` bin + scripts, RETIRE `src/pairing.ts`, README quickstart

Wire the `nexus-executor` bin into `package.json`, replace `npm run pair` with `nexus-executor pair`, retire the old `src/pairing.ts` CLI entry (its logic lives in `src/pairing/core.ts` now), and update the README.

**Files:**
- Modify: `package.json`
- Modify (delete if clean): `src/pairing.ts` → replace with a thin note, or remove its `npm run pair` script.
- Modify: `README.md`

- [ ] **Step 1: Update `package.json`**

Add `"bin"` and a `cli` script; point `pair` at the CLI:

```json
{
  "bin": {
    "nexus-executor": "bin/nexus-executor"
  },
  "scripts": {
    "build": "tsc",
    "migrate": "tsx --env-file=.env src/main.ts --migrate-only",
    "dev": "tsx watch --env-file=.env src/main.ts",
    "start": "node --env-file=.env dist/main.js",
    "test": "vitest run",
    "pair": "tsx src/cli/pair.ts",
    "cli": "tsx src/cli/cli.ts"
  }
}
```

(Keep `start`/`migrate`/`dev` unchanged. `npm run pair` now invokes the CLI's pair logic via a thin wrapper, OR you drop it — the README tells users to run `nexus-executor pair`.)

> **Implementer note:** `bin/nexus-executor` imports `../dist/cli/cli.js` (node's ESM). `src/cli/cli.ts` is compiled by `tsc` to `dist/cli/cli.js`. For `npm run pair`, create a tiny `src/cli/pair-cli.ts` that calls `pairFromCli({ argv: process.argv.slice(2) })` and prints the result, OR keep the script as `tsx src/cli/pair.ts` if it has an inline run-guard. Decide which is cleanest and keep it runnable.

- [ ] **Step 2: Retire `src/pairing.ts`**

The old `npm run pair` entry pointed at `src/pairing.ts`. Its `claimPairing` is still used by `src/pairing/core.ts` (direct transport) and by `src/main.ts` (boot). **Keep** `src/pairing.ts` as the `claimPairing` implementation module (do NOT delete it — `core.ts` imports it). Only remove its stale `invokedDirectly`/`cli()` block if it's now dead. Verify with:

Run: `npx vitest run`
Expected: PASS — nothing that imports `pairing.ts` breaks.

- [ ] **Step 3: Update `README.md`**

Replace the `npm run pair` references in the quickstart with `nexus-executor pair` (interactive) / `nexus-executor pair --gateway <url> --code <code>` (automation). Add a short section:

```markdown
## Control CLI

`nexus-executor` is the executor's control command (install with `npm link`
or `npm i -g`):

    nexus-executor              → status summary
    nexus-executor pair         → interactive pairing (gateway by default)
    nexus-executor pair --gateway URL --code CODE   → non-interactive
    nexus-executor status --json
    nexus-executor pair --hub URL --code CODE       → direct transport
    nexus-executor unpair | version | doctor | config | logs | update

Install a machine with:

    curl -fsSL https://executor.example.com/install | bash
```

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`

Expected: PASS. No `npm run pair` references to a deleted entry remain in the README/scripts that would break.

- [ ] **Step 5: Commit**

```bash
git add package.json src/pairing.ts src/cli/pair-cli.ts README.md
git commit -m "feat(executor): wire nexus-executor bin + docs"
```

---

## Verification / acceptance

- [ ] `npx vitest run` — all executor unit/CLI tests pass.
- [ ] `npx tsc --noEmit` — clean typecheck.
- [ ] `bash -n install.sh && shellcheck install.sh` — installer lints.
- [ ] `bash install.sh --dry-run --gateway https://g.example.com --code ABC` — dry-run exits 0.
- [ ] Manual smoke (after build): `nexus-executor status` → "not paired"; `nexus-executor pair` → enrolls; `nexus-executor status` → enrolled; `nexus-executor doctor --json` → paired true.
- [ ] README quickstart reflects `nexus-executor pair`/`status` and `curl | bash`.

## Rollout / migration

- The service still falls back to env-driven pairing/transport when no CLI state exists (Task 6), so existing `.env`/container installs keep working until they run `nexus-executor pair`.
- `src/pairing.ts` is kept as the `claimPairing` implementation module; only its standalone CLI entry is retired.
- The executor-send-`name` work (branch `executor-gw-name`, commit `00be0c1`) should be merged/rebased ahead of this if you want `pair` to send `EXECUTOR_NAME` on the same deploy. This plan assumes it is or is not merged independently; `core.ts` reads `req.executorName` for the CLI state but does not depend on the name being sent.