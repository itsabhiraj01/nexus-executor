import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { TerminalStore, type TerminalSessionRecord } from './terminal-store.js';

/**
 * Persistent tmux-backed terminal sessions, synced AGAINST THE WHOLE tmux
 * server — not just the sessions this executor created.
 *
 * tmux is the ground truth: sessions live in the tmux server and survive
 * executor restarts. Every list() reconciles a full inventory
 * (`list-sessions -F …` + a server-identity probe): sessions made BY HAND on
 * the box are imported with stable `nxt-*` public ids (an existing `nxt-*`
 * name keeps it), sessions that disappeared become `exited` tombstones for
 * TOMBSTONE_MS, and the public-id ↔ tmux mapping is persisted in
 * `executor.terminal_sessions` (when a store is injected) so a restart
 * re-threads every attachment instead of re-adopting by name.
 *
 * Identity is the (server, native $id, native created) triple — never the
 * mutable tmux name: a rename (`tmux rename-session`) keeps the public id,
 * and a `$N` recycled by a fresh tmux server can never impersonate the old
 * registration. tmux *targets* (`attach`, `capture-pane`, `kill-session`)
 * use the native `$N`.
 *
 * Discovery is passive: reconciling attaches NO pty, spawns NO shell,
 * resizes nothing. The ten-minute exited display and the byte-bounded ring
 * buffer semantics are unchanged from the pre-sync registry: output is
 * streamed from an attached pty into a per-session ring; a read passes a
 * cursor (`sinceSeq`) and gets back every chunk with `seq >= sinceSeq` plus
 * the next cursor as `seq`; readers long-poll up to `min(holdMs, maxHoldMs)`
 * resolving early on data or eof; an under-retained cursor resyncs from a
 * `capture-pane` snapshot.
 *
 * Failure discipline: a "no tmux server" answer is a LEGITIMATE empty
 * inventory (the server owns its sessions — they die with it), while
 * timeouts, permission errors and malformed output fail the scan (the
 * resulting TerminalTmuxError surfaces as a 502 through the op layer) and
 * mark NOTHING exited.
 */

const execFileAsync = promisify(execFile);

const TMUX_TIMEOUT_MS = 10_000;

/** Only these vars reach the shell; secrets like DATABASE_URL never do. */
const ENV_PASSTHROUGH = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'SHELL',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'SSH_AUTH_SOCK',
];

/** tmux session names are used as CLI args: keep their charset boring. */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Minimal pty surface (node-pty's IPty satisfies this). */
export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}

export type PtySpawner = (
  command: string, args: string[],
  opts: { cwd: string; env: Record<string, string>; cols: number; rows: number },
) => PtyProcess;

export type TmuxRunner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface TerminalSessionInfo {
  id: string;
  name: string;
  cols: number;
  rows: number;
  status: 'live' | 'exited';
  /** Nexus-side attached viewers (console streams). Kept for older hubs. */
  clients: number;
  /** tmux' real attached-client count — the executor's own pty attach and
   *  any out-of-band `tmux attach` included. Absent for exited rows. */
  tmuxClients?: number;
  /** 'created' = made through the executor; 'imported' = backfilled from a
   *  manually created tmux session. Absent on rows a store-less registry
   *  can't vouch for. */
  origin?: 'created' | 'imported';
  createdAt: string;
  lastActiveAt: string;
}

export interface OutputChunk { seq: number; data: string }

export interface ReadResult {
  seq: number;
  chunks: OutputChunk[];
  snapshot: string | null;
  status: 'live' | 'exited';
  eof: boolean;
}

export interface TerminalRegistryOptions {
  spawner: PtySpawner;
  tmux: TmuxRunner;
  tmuxAvailable: () => Promise<boolean>;
  /** Durable registration store (Postgres). Optional ONLY for tests — main
   *  always injects it; without it imports stay memory-only. */
  store?: TerminalStore | null;
  maxSessions?: number;
  ringBytes?: number;
  maxHoldMs?: number;
  now?: () => number;
}

const SESSION_PREFIX = 'nxt-';
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_RING_BYTES = 256 * 1024;
const DEFAULT_MAX_HOLD_MS = 15_000;
const TOMBSTONE_MS = 10 * 60_000;
const MAX_COLS = 500;
const MAX_ROWS = 200;

/** The shape a discovered tmux name must match to BE adopted as its public
 *  id (initial backfill / post-restart recovery); anything else gets a
 *  freshly minted `nxt-*` id. */
const PUBLIC_ID_PATTERN = /^nxt-[A-Za-z0-9_-]+$/;

/* ── tmux escaped-format inventory ────────────────────────────────────── *
 * tmux renders -F output C-style-escaped: `\` → `\\`, tab → `\t`, other
 * non-printables → `\NNN` octal. We pass a raw US byte (0x1f) as the field
 * separator — tmux renders it verbatim as the escape text `\037` — so a
 * separator can never collide with a printable char in a name, and a
 * sequential unescape is unambiguous. Lines stay LF-separated: a newline
 * INSIDE a name comes through escaped, never raw. */
const FIELD_SEP = '\x1f';
const FIELD_SEP_WIRE = '\\037';
const LIST_FORMAT = [
  '#{session_id}', '#{session_name}', '#{session_created}', '#{session_activity}',
  '#{window_width}', '#{window_height}', '#{session_attached}',
].join(FIELD_SEP);
const SERVER_FORMAT = ['#{pid}', '#{start_time}', '#{socket_path}'].join(FIELD_SEP);
const CREATE_FORMAT = ['#{session_id}', '#{session_created}'].join(FIELD_SEP);

/** Reverse tmux' output escaping (see above). Unknown escapes stay raw. */
export function unescapeTmux(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch !== '\\') { out += ch; continue; }
    const next = value[i + 1];
    if (next === '\\') { out += '\\'; i += 1; continue; }
    if (next === 't') { out += '\t'; i += 1; continue; }
    if (next === 'n') { out += '\n'; i += 1; continue; }
    if (next === 'r') { out += '\r'; i += 1; continue; }
    const octal = /^[0-7]{3}$/.exec(value.slice(i + 1, i + 4));
    if (octal) { out += String.fromCharCode(Number.parseInt(octal[0], 8)); i += 3; continue; }
    out += ch; // lone backslash — keep it verbatim
  }
  return out;
}

export interface TmuxInventorySession {
  /** Native tmux session id ("$N") — the attach/kill/capture target. */
  sessionId: string;
  /** The (mutable) tmux session name, unescaped. */
  name: string;
  /** session_created, epoch ms. */
  created: number;
  /** session_attached — the tmux-wide attached client count. */
  attached: number;
  width: number | null;
  height: number | null;
}

export interface TmuxInventory {
  /** Server identity (socket path + start time + pid); '' when NO server. */
  serverKey: string;
  sessions: TmuxInventorySession[];
}

function parseInteger(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) ? value : null;
}

/** Parse one inventory (throws on malformed output — a half-read scan must
 *  never be the basis for exit marking). */
export function parseInventoryOutput(stdout: string, serverKey: string): TmuxInventory {
  const sessions: TmuxInventorySession[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    let parts = line.split(FIELD_SEP_WIRE);
    if (parts.length > 7) {
      // The name itself contained an escaped US byte: fold the overflow back
      // into the name field (the numeric fields can never hold a separator).
      const overflow = parts.length - 7;
      parts = [parts[0]!, parts.slice(1, 2 + overflow).join(FIELD_SEP_WIRE), ...parts.slice(2 + overflow)];
    }
    if (parts.length !== 7 || !parts.every((part) => part !== undefined)) {
      throw new TerminalTmuxError(`malformed tmux list-sessions line: ${JSON.stringify(line.slice(0, 200))}`);
    }
    const [sessionId, rawName, rawCreated, _activity, rawWidth, rawHeight, rawAttached] = parts as [
      string, string, string, string, string, string, string,
    ];
    const created = parseInteger(rawCreated);
    const attached = parseInteger(rawAttached);
    if (!/^\$\d+$/.test(sessionId) || created === null || attached === null) {
      throw new TerminalTmuxError(`malformed tmux list-sessions line: ${JSON.stringify(line.slice(0, 200))}`);
    }
    sessions.push({
      sessionId,
      name: unescapeTmux(rawName),
      created: created * 1000,
      attached,
      width: parseInteger(rawWidth),
      height: parseInteger(rawHeight),
    });
  }
  return { serverKey, sessions };
}

/** Clamp an untrusted size request so NaN/negative/huge never reaches tmux. */
function clampSize(value: number, fallback: number, max: number): number {
  const n = Math.trunc(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** "no server running on …" / "error connecting to …" — a legitimate empty
 *  inventory, NOT a scan failure: sessions die with their server. */
function isNoTmuxServer(res: { code: number; stderr: string }): boolean {
  return res.code !== 0 && /no server running|error connecting|can't find socket/i.test(res.stderr);
}

interface Session {
  /** Public id (nxt-*): the registry-facing identity. */
  id: string;
  /** Display name (tracks tmux renames for imported sessions). */
  name: string;
  /** Attach/kill/capture target: the native "$N" (rename-proof). */
  tmuxTarget: string;
  /** Last-seen tmux name. */
  tmuxName: string;
  /** The tmux server identity this session was verified on. */
  tmuxServer: string;
  /** tmux session_created, epoch seconds. */
  tmuxCreated: number;
  origin: 'created' | 'imported';
  cols: number;
  rows: number;
  createdAt: number;
  lastActiveAt: number;
  /** Last inventory's session_attached (tmux' own client count — the
   *  executor's pty attach and out-of-band `tmux attach` included). */
  tmuxClients: number;
  pty: PtyProcess | null;
  seq: number;
  ring: OutputChunk[];
  ringBytesUsed: number;
  /** Nexus-side attached viewers (console streams) — the legacy `clients`. */
  clients: number;
  waiters: Array<() => void>;
  eofSignaled: boolean;
}

interface Tombstone { id: string; name: string; at: number; createdAt: number; origin: 'created' | 'imported' }

/** Default tmux runner (used by main.ts). */
export function defaultTmuxRunner(): TmuxRunner {
  return async (args) => {
    try {
      const { stdout, stderr } = await execFileAsync('tmux', args, { timeout: TMUX_TIMEOUT_MS });
      return { code: 0, stdout: String(stdout), stderr: String(stderr) };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
      if (e.killed) return { code: 124, stdout: e.stdout ?? '', stderr: 'tmux timed out' };
      return { code: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };
}

/** The registry needs `new-session -e`, which requires tmux >= 3.2. */
export function defaultTmuxAvailable(): () => Promise<boolean> {
  let cached: boolean | null = null;
  const run = defaultTmuxRunner();
  return async () => {
    if (cached === null) {
      const res = await run(['-V']);
      cached = res.code === 0 && /tmux (3\.[2-9]|[4-9]\.)/.test(res.stdout);
    }
    return cached;
  };
}

export class TerminalCapError extends Error {
  constructor(max: number) {
    super(`Terminal session limit reached (max ${max}). Kill an existing session first.`);
    this.name = 'TerminalCapError';
  }
}

export class TerminalTmuxError extends Error {
  constructor(message: string) { super(message); this.name = 'TerminalTmuxError'; }
}

export class TerminalRegistry {
  private sessions = new Map<string, Session>();
  private tombstones: Tombstone[] = [];
  /** Serializes create + reconcile: the cap check, inventory-driven updates
   *  and registration writes must never interleave between two scans. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly maxSessions: number;
  private readonly ringBytes: number;
  private readonly maxHoldMs: number;
  private readonly now: () => number;
  constructor(private readonly opts: TerminalRegistryOptions) {
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.ringBytes = opts.ringBytes ?? DEFAULT_RING_BYTES;
    this.maxHoldMs = opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  available(): Promise<boolean> { return this.opts.tmuxAvailable(); }

  create(input: { cols: number; rows: number; name?: string; idempotencyKey?: string }): Promise<{ id: string; name: string; createdAt: string }> {
    // Serialized: cap check + new-session + registration form one atomic
    // step against reconciles and each other (the stored link swallows
    // rejections so one failure can't poison later callers).
    return this.serialized(() => this.doCreate(input));
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.chain.then(fn);
    this.chain = pending.catch(() => {});
    return pending;
  }

  private async doCreate(input: { cols: number; rows: number; name?: string; idempotencyKey?: string }): Promise<{ id: string; name: string; createdAt: string }> {
    if (input.idempotencyKey !== undefined && !ID_PATTERN.test(input.idempotencyKey)) {
      throw new TerminalTmuxError(`Invalid terminal id '${input.idempotencyKey}' (allowed: ${String(ID_PATTERN)})`);
    }
    const cols = clampSize(input.cols, 80, MAX_COLS);
    const rows = clampSize(input.rows, 24, MAX_ROWS);
    const id = input.idempotencyKey ? SESSION_PREFIX + input.idempotencyKey : this.newId();
    if (this.sessions.has(id)) {
      const existing = this.sessions.get(id)!;
      return { id: existing.id, name: existing.name, createdAt: new Date(existing.createdAt).toISOString() };
    }
    // Reconcile FIRST: it imports whatever appeared on the box (imports count
    // toward the cap) and — after a restart — re-adopts the very session a
    // retried create is keyed to, so the idempotency key survives restarts.
    const inventory = await this.reconcile();
    {
      const existing = this.sessions.get(id);
      if (existing) {
        return { id: existing.id, name: existing.name, createdAt: new Date(existing.createdAt).toISOString() };
      }
    }
    if (this.sessions.size >= this.maxSessions) throw new TerminalCapError(this.maxSessions);
    const res = await this.opts.tmux([
      'new-session', '-d',
      '-s', id,
      '-x', String(cols),
      '-y', String(rows),
      '-e', 'TERM=xterm-256color',
      '-P', '-F', CREATE_FORMAT,
    ]);
    if (res.code !== 0) {
      throw new TerminalTmuxError(`tmux new-session failed (code ${res.code}): ${res.stderr}`);
    }
    const createdParts = res.stdout.trim().split(FIELD_SEP_WIRE);
    const nativeId = createdParts[0] ?? '';
    const created = parseInteger(createdParts[1] ?? '');
    if (createdParts.length !== 2 || !/^\$\d+$/.test(nativeId) || created === null) {
      throw new TerminalTmuxError(`malformed tmux new-session response: ${JSON.stringify(res.stdout.slice(0, 200))}`);
    }
    // Inventory said "no server" before this session existed — the new
    // session booted one. Probe identity AFTER creation in that case.
    const serverKey = inventory.serverKey || await this.probeServerKey();
    const at = this.now();
    if (this.opts.store) {
      try {
        await this.opts.store.upsertLive({
          identity: { server: serverKey, sessionId: nativeId, createdAt: new Date(created * 1000) },
          tmuxName: id,
          candidatePublicId: id,
          mintPublicId: () => this.newId(),
          origin: 'created',
          displayName: input.name ?? id,
          lastActiveAt: new Date(at),
          now: new Date(at),
        });
      } catch (error) {
        // No half-registration: a console retry with the same key must not
        // find an unregistered session — tear the fresh tmux session down.
        await this.opts.tmux(['kill-session', '-t', nativeId]).catch(() => {});
        throw error;
      }
    }
    const session: Session = {
      id,
      name: input.name ?? id,
      tmuxTarget: nativeId,
      tmuxName: id,
      tmuxServer: serverKey,
      tmuxCreated: created,
      origin: 'created',
      cols,
      rows,
      createdAt: at,
      lastActiveAt: at,
      tmuxClients: 0,
      pty: null,
      seq: 1,
      ring: [],
      ringBytesUsed: 0,
      clients: 0,
      waiters: [],
      eofSignaled: false,
    };
    this.sessions.set(id, session);
    this.attachPty(session);
    return { id, name: session.name, createdAt: new Date(at).toISOString() };
  }

  async list(): Promise<{ sessions: TerminalSessionInfo[] }> {
    const now = this.now();
    this.tombstones = this.tombstones.filter((t) => now - t.at < TOMBSTONE_MS);
    // A FAILED scan throws here (→ 502 at the op layer) having marked
    // NOTHING exited — only a fully successful inventory drives exits.
    await this.serialized(() => this.reconcile());
    return { sessions: await this.composeList(now) };
  }

  /** Compose the answer from memory + the store's tombstone window. */
  private async composeList(now: number): Promise<TerminalSessionInfo[]> {
    const infos: TerminalSessionInfo[] = [...this.sessions.values()].map((s) => ({
      id: s.id,
      name: s.name,
      cols: s.cols,
      rows: s.rows,
      status: 'live',
      clients: s.clients,
      tmuxClients: s.tmuxClients,
      origin: s.origin,
      createdAt: new Date(s.createdAt).toISOString(),
      lastActiveAt: new Date(s.lastActiveAt).toISOString(),
    }));
    const seen = new Set(infos.map((info) => info.id));
    for (const t of this.tombstones) {
      infos.push({
        id: t.id,
        name: t.name,
        cols: 0,
        rows: 0,
        status: 'exited',
        clients: 0,
        origin: t.origin,
        createdAt: new Date(t.createdAt).toISOString(),
        lastActiveAt: new Date(t.at).toISOString(),
      });
      seen.add(t.id);
    }
    // Cross-restart tombstones: exited rows scraped from the store that this
    // process never saw die get the same 10-minute display.
    if (this.opts.store) {
      const rows = await this.opts.store.recentlyExited(new Date(now - TOMBSTONE_MS));
      for (const row of rows) {
        if (seen.has(row.publicId)) continue;
        infos.push({
          id: row.publicId,
          name: row.name,
          cols: 0,
          rows: 0,
          status: 'exited',
          clients: 0,
          origin: row.origin,
          createdAt: row.tmuxCreatedAt.toISOString(),
          lastActiveAt: (row.exitedAt ?? row.lastSeenAt).toISOString(),
        });
      }
    }
    return infos;
  }

  input(id: string, data: string): 'ok' | 'not_found' {
    const session = this.sessions.get(id);
    if (!session || session.eofSignaled) return 'not_found';
    session.lastActiveAt = this.now();
    // Imported/unattached sessions have no pty yet: attach lazily so input
    // actually reaches the shell instead of vanishing.
    this.attachPty(session);
    session.pty?.write(data);
    return 'ok';
  }

  resize(id: string, cols: number, rows: number): 'ok' | 'not_found' {
    const session = this.sessions.get(id);
    if (!session || session.eofSignaled) return 'not_found';
    session.cols = clampSize(cols, 80, MAX_COLS);
    session.rows = clampSize(rows, 24, MAX_ROWS);
    session.lastActiveAt = this.now();
    this.attachPty(session);
    session.pty?.resize(session.cols, session.rows);
    return 'ok';
  }

  async read(id: string, sinceSeq: number, holdMs: number, attach: boolean): Promise<ReadResult | null> {
    // Adopt survivors on first touch: after a restart the very first call
    // reaching a session is a read, and the tmux inventory (not this map)
    // is ground truth.
    const session = this.sessions.get(id) ?? await this.ensureKnown(id);
    if (!session) return null;
    if (attach) {
      session.clients += 1;
      this.attachPty(session);
    }
    const capture = async (): Promise<string | null> => {
      const res = await this.opts.tmux(['capture-pane', '-p', '-e', '-J', '-t', session.tmuxTarget, '-S', '-2000']);
      return res.code === 0 ? res.stdout : null;
    };
    let snapshot: string | null = null;
    if (attach && session.ring.length === 0 && !session.eofSignaled) snapshot = await capture();
    // Caller fell behind the retained window: resync from a pane snapshot.
    const earliest = session.ring[0];
    if (sinceSeq > 0 && earliest !== undefined && earliest.seq > sinceSeq) {
      return {
        seq: session.seq,
        chunks: [],
        snapshot: await capture(),
        status: session.eofSignaled ? 'exited' : 'live',
        eof: session.eofSignaled,
      };
    }
    // An attach-time snapshot goes out at once: the long-poll below only
    // runs when there is nothing to hand back yet.
    if (snapshot !== null) {
      return {
        seq: session.seq,
        chunks: [],
        snapshot,
        status: session.eofSignaled ? 'exited' : 'live',
        eof: session.eofSignaled,
      };
    }
    const result = (): ReadResult => ({
      seq: session.seq,
      chunks: session.ring.filter((c) => c.seq >= sinceSeq),
      snapshot,
      status: session.eofSignaled ? 'exited' : 'live',
      eof: session.eofSignaled,
    });
    if (result().chunks.length > 0 || session.eofSignaled) return result();
    const hold = Math.min(Math.max(holdMs, 0), this.maxHoldMs);
    if (hold <= 0) return result();
    return await new Promise<ReadResult>((resolve) => {
      let settled = false;
      const finish = (timedOut: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!timedOut) {
          resolve(result());
        } else {
          session.waiters = session.waiters.filter((w) => w !== waiter);
          resolve({ seq: session.seq, chunks: [], snapshot: null, status: 'live', eof: false });
        }
      };
      const waiter = () => finish(false);
      const timer = setTimeout(() => finish(true), hold);
      timer.unref?.(); // a parked read must never delay process exit
      session.waiters.push(waiter);
    });
  }

  detach(id: string): 'ok' | 'not_found' {
    const session = this.sessions.get(id);
    if (!session) return 'not_found';
    session.clients = Math.max(0, session.clients - 1);
    return 'ok';
  }

  /** Idempotent by contract: unknown/lost ids still answer 'ok' — and the
   *  durable row (if any) is stamped exited so the tombstone shows. */
  async kill(id: string): Promise<'ok'> {
    const session = this.sessions.get(id)
      ?? (this.isTombstoned(id) ? null : await this.ensureKnown(id).catch(() => null));
    const stomp = async (): Promise<void> => {
      if (!this.opts.store) return;
      await this.opts.store.markExited(id, new Date(this.now())).catch(() => {});
    };
    if (session) {
      try { session.pty?.kill(); } catch { /* already dead */ }
      session.pty = null;
      this.exiting(session);
      await stomp();
      try {
        await this.opts.tmux(['kill-session', '-t', session.tmuxTarget]);
      } catch {
        // best effort: the registry is consistent without the tmux call
      }
      return 'ok';
    }
    await stomp();
    return 'ok';
  }

  async stopAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      try { session.pty?.kill(); } catch { /* already dead */ }
      session.pty = null;
      // Tombstone + drain waiters: parked readers resolve with eof instead
      // of winding up their hold timers after shutdown. NOT stamped into the
      // store — the sessions themselves survive (tmux outlives this process).
      this.exiting(session);
    }
  }

  /* — discovery & reconciliation — */

  /** The full-server inventory via an escaped formatted scan (see the
   *  format note at the top). */
  private async scanTmux(): Promise<TmuxInventory> {
    const res = await this.opts.tmux(['list-sessions', '-F', LIST_FORMAT]);
    if (res.code !== 0) {
      if (isNoTmuxServer(res)) return { serverKey: '', sessions: [] };
      throw new TerminalTmuxError(`tmux list-sessions failed (code ${res.code}): ${res.stderr.trim()}`);
    }
    if (res.stdout.trim() === '') return { serverKey: await this.probeServerKey(), sessions: [] };
    const serverKey = await this.probeServerKey();
    return parseInventoryOutput(res.stdout, serverKey);
  }

  /** The tmux server identity: socket path + server start time + pid. */
  private async probeServerKey(): Promise<string> {
    const res = await this.opts.tmux(['display-message', '-p', SERVER_FORMAT]);
    if (res.code !== 0) {
      if (isNoTmuxServer(res)) return '';
      throw new TerminalTmuxError(`tmux server probe failed (code ${res.code}): ${res.stderr.trim()}`);
    }
    const [pid, startTime, socket] = res.stdout.trim().split(FIELD_SEP_WIRE);
    if (!pid || !startTime || !socket) {
      throw new TerminalTmuxError(`malformed tmux server probe: ${JSON.stringify(res.stdout.slice(0, 200))}`);
    }
    return `${socket}#${startTime}.${pid}`;
  }

  /**
   * Reconcile the registry with ONE tmux inventory (serialized against
   * create by the caller): imports new discoveries, refreshes dimensions /
   * attached counts / renames, marks the vanished exited — in memory and in
   * the store. A single successful snapshot drives BOTH updates, so a failed
   * scan (throwing paths above) can never half-mark exits.
   */
  private async reconcile(): Promise<TmuxInventory> {
    const inventory = await this.scanTmux();
    const now = this.now();
    const keep: string[] = [];
    for (const discovered of inventory.sessions) {
      const existing = this.findByTmuxIdentity(inventory.serverKey, discovered);
      if (existing) {
        existing.tmuxName = discovered.name;
        if (existing.origin === 'imported') existing.name = discovered.name;
        existing.tmuxClients = discovered.attached;
        existing.cols = discovered.width ?? existing.cols;
        existing.rows = discovered.height ?? existing.rows;
        keep.push(existing.id);
        if (this.opts.store) {
          await this.opts.store.upsertLive({
            identity: { server: inventory.serverKey, sessionId: discovered.sessionId, createdAt: new Date(discovered.created) },
            tmuxName: discovered.name,
            candidatePublicId: existing.id,
            mintPublicId: () => this.newId(),
            origin: existing.origin,
            displayName: existing.name,
            lastActiveAt: new Date(existing.lastActiveAt),
            now: new Date(now),
          });
        }
        continue;
      }
      // A freshly discovered session: the public id prefers its existing
      // nxt-* tmux name (initial backfill / post-restart recovery), anything
      // else gets a freshly minted one.
      const candidate = PUBLIC_ID_PATTERN.test(discovered.name) ? discovered.name : null;
      let record: TerminalSessionRecord | null = null;
      if (this.opts.store) {
        record = await this.opts.store.upsertLive({
          identity: { server: inventory.serverKey, sessionId: discovered.sessionId, createdAt: new Date(discovered.created) },
          tmuxName: discovered.name,
          candidatePublicId: candidate,
          mintPublicId: () => this.newId(),
          origin: 'imported',
          now: new Date(now),
        });
      }
      const publicId = record?.publicId ?? this.newId(candidate ?? undefined);
      // If an in-memory session already holds that public id under a DIFFERENT
      // tmux identity (its session died and the name/$id got reused), the old
      // entry is obsolete — tombstone it before the replacement lands.
      const stale = this.sessions.get(publicId);
      if (stale) this.exiting(stale);
      const session: Session = {
        id: publicId,
        name: record?.name ?? discovered.name,
        tmuxTarget: discovered.sessionId,
        tmuxName: discovered.name,
        tmuxServer: inventory.serverKey,
        tmuxCreated: Math.floor(discovered.created / 1000),
        origin: record?.origin ?? 'imported',
        cols: discovered.width ?? 80,
        rows: discovered.height ?? 24,
        createdAt: record?.tmuxCreatedAt.getTime() ?? discovered.created,
        lastActiveAt: record?.lastActiveAt.getTime() ?? now,
        tmuxClients: discovered.attached,
        pty: null,
        seq: 1,
        ring: [],
        ringBytesUsed: 0,
        clients: 0,
        waiters: [],
        eofSignaled: false,
      };
      this.sessions.set(publicId, session);
      keep.push(publicId);
    }
    // The same successful inventory's missing set = the exited set.
    for (const session of [...this.sessions.values()]) {
      if (!keep.includes(session.id)) this.exiting(session);
    }
    if (this.opts.store) {
      const transitioned = await this.opts.store.markMissingExited(keep, new Date(now));
      for (const row of transitioned) {
        if (this.tombstones.some((t) => t.id === row.publicId)) continue;
        this.tombstones.push({
          id: row.publicId,
          name: row.name,
          at: now,
          createdAt: row.tmuxCreatedAt.getTime(),
          origin: row.origin,
        });
      }
    }
    return inventory;
  }

  private findByTmuxIdentity(serverKey: string, discovered: TmuxInventorySession): Session | null {
    for (const session of this.sessions.values()) {
      if (session.tmuxServer === serverKey
        && session.tmuxTarget === discovered.sessionId
        && session.tmuxCreated === Math.floor(discovered.created / 1000)) return session;
    }
    return null;
  }

  private isTombstoned(id: string): boolean {
    return this.tombstones.some((t) => t.id === id);
  }

  /** Cold-path lookup for ops by public id: confirmed-dead ids short-circuit;
   *  anything else runs one full serialized reconcile (which upserts and
   *  identity-verifies everything it adopts — a stale store row can never
   *  retarget a replacement session, the triple must match). */
  private async ensureKnown(id: string): Promise<Session | null> {
    if (this.isTombstoned(id)) return null;
    await this.serialized(() => this.reconcile());
    return this.sessions.get(id) ?? null;
  }

  private newId(preferred?: string): string {
    if (preferred && !this.sessions.has(preferred) && !this.isTombstoned(preferred)) return preferred;
    let id = SESSION_PREFIX + randomBytes(3).toString('hex');
    while (this.sessions.has(id)) id = SESSION_PREFIX + randomBytes(3).toString('hex');
    return id;
  }

  private attachPty(session: Session): void {
    if (session.pty) return;
    const env: Record<string, string> = {};
    for (const key of ENV_PASSTHROUGH) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env.TERM = 'xterm-256color';
    const pty = this.opts.spawner('tmux', ['attach', '-t', session.tmuxTarget], {
      cwd: process.cwd(),
      env,
      cols: session.cols,
      rows: session.rows,
    });
    session.pty = pty;
    pty.onData((data) => {
      session.ring.push({ seq: session.seq++, data });
      session.ringBytesUsed += Buffer.byteLength(data, 'utf8');
      while (session.ringBytesUsed > this.ringBytes && session.ring.length > 0) {
        const evicted = session.ring.shift();
        if (!evicted) break;
        session.ringBytesUsed -= Buffer.byteLength(evicted.data, 'utf8');
      }
      this.wake(session);
    });
    pty.onExit(() => {
      // Only detach here: eof is decided against the tmux inventory, not the
      // pty. Identity check: a stale exit must not null a replacement pty.
      if (session.pty === pty) session.pty = null;
    });
  }

  private exiting(session: Session): void {
    session.eofSignaled = true;
    if (this.sessions.delete(session.id) && !this.tombstones.some((t) => t.id === session.id)) {
      this.tombstones.push({ id: session.id, name: session.name, at: this.now(), createdAt: session.createdAt, origin: session.origin });
    }
    this.wake(session);
  }

  private wake(session: Session): void {
    const waiters = session.waiters;
    session.waiters = [];
    for (const waiter of waiters) waiter();
  }
}
