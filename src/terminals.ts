import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Persistent tmux-backed terminal sessions.
 *
 * tmux is the ground truth: sessions live in the tmux server and survive
 * executor restarts, so `list()` re-adopts any `nxt-*` session it does not
 * know about and eof is decided against tmux (`has-session`) — the client's
 * pty is just an attach, its `onExit` only detaches, never signals eof.
 *
 * Output is streamed from the attached pty into a byte-bounded ring buffer.
 * Chunk seqs are allocated from 1; a read passes a cursor (`sinceSeq`) and
 * gets back every chunk with `seq >= sinceSeq` plus the next cursor as
 * `seq` (the next unallocated sequence number). A caller whose cursor fell
 * behind the retained window gets an immediate `capture-pane` snapshot to
 * resync instead of a partial stream; attaching to a session with an empty
 * ring (e.g. right after a restart) gets the same snapshot treatment.
 *
 * Reads long-poll: with nothing new to report they park up to
 * `min(holdMs, maxHoldMs)` and resolve early on new data or eof. A session
 * that disappeared from tmux becomes a tombstone for TOMBSTONE_MS so
 * clients polling for it see status 'exited' (and eof) instead of a bare
 * not-found.
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
  clients: number;
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

/** Clamp an untrusted size request so NaN/negative/huge never reaches tmux. */
function clampSize(value: number, fallback: number, max: number): number {
  const n = Math.trunc(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

interface Session {
  id: string;
  name: string;
  cols: number;
  rows: number;
  createdAt: number;
  lastActiveAt: number;
  pty: PtyProcess | null;
  seq: number;
  ring: OutputChunk[];
  ringBytesUsed: number;
  clients: number;
  waiters: Array<() => void>;
  eofSignaled: boolean;
}

interface Tombstone { id: string; name: string; at: number; createdAt: number }

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
  private createChain: Promise<unknown> = Promise.resolve();
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
    // Serialized: the cap check + tmux new-session pair is otherwise a TOCTOU
    // race between concurrent creates. A rejected create must not poison the
    // chain, so the stored link swallows rejections while callers see them.
    const pending = this.createChain.then(() => this.doCreate(input));
    this.createChain = pending.catch(() => {});
    return pending;
  }

  private async doCreate(input: { cols: number; rows: number; name?: string; idempotencyKey?: string }): Promise<{ id: string; name: string; createdAt: string }> {
    if (input.idempotencyKey !== undefined && !ID_PATTERN.test(input.idempotencyKey)) {
      throw new TerminalTmuxError(`Invalid terminal id '${input.idempotencyKey}' (allowed: ${String(ID_PATTERN)})`);
    }
    const cols = clampSize(input.cols, 80, MAX_COLS);
    const rows = clampSize(input.rows, 24, MAX_ROWS);
    const id = input.idempotencyKey ? SESSION_PREFIX + input.idempotencyKey : this.newId();
    const existing = this.sessions.get(id);
    if (existing) {
      return { id: existing.id, name: existing.name, createdAt: new Date(existing.createdAt).toISOString() };
    }
    const live = await this.liveSessions();
    if (live.length >= this.maxSessions) throw new TerminalCapError(this.maxSessions);
    const res = await this.opts.tmux([
      'new-session', '-d',
      '-s', id,
      '-x', String(cols),
      '-y', String(rows),
      '-e', 'TERM=xterm-256color',
    ]);
    if (res.code !== 0) {
      throw new TerminalTmuxError(`tmux new-session failed (code ${res.code}): ${res.stderr}`);
    }
    const at = this.now();
    const session: Session = {
      id,
      name: input.name ?? id,
      cols,
      rows,
      createdAt: at,
      lastActiveAt: at,
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
    for (const { id, created } of await this.liveSessions()) {
      if (this.sessions.has(id)) continue;
      await this.adoptIfLive(id, created ?? undefined);
    }
    for (const session of [...this.sessions.values()]) {
      const res = await this.opts.tmux(['has-session', '-t', session.id]);
      if (res.code !== 0) this.exiting(session);
    }
    const infos: TerminalSessionInfo[] = [...this.sessions.values()].map((s) => ({
      id: s.id,
      name: s.name,
      cols: s.cols,
      rows: s.rows,
      status: 'live',
      clients: s.clients,
      createdAt: new Date(s.createdAt).toISOString(),
      lastActiveAt: new Date(s.lastActiveAt).toISOString(),
    }));
    for (const t of this.tombstones) {
      infos.push({
        id: t.id,
        name: t.name,
        cols: 0,
        rows: 0,
        status: 'exited',
        clients: 0,
        createdAt: new Date(t.createdAt).toISOString(),
        lastActiveAt: new Date(t.at).toISOString(),
      });
    }
    return { sessions: infos };
  }

  input(id: string, data: string): 'ok' | 'not_found' {
    const session = this.sessions.get(id);
    if (!session || session.eofSignaled) return 'not_found';
    session.lastActiveAt = this.now();
    // Adopted/dead-client sessions have no pty yet: attach lazily so input
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
    // reaching a session is a read, and tmux (not this map) is ground truth.
    const session = this.sessions.get(id) ?? await this.adoptIfLive(id);
    if (!session) return null;
    if (attach) {
      session.clients += 1;
      this.attachPty(session);
    }
    const capture = async (): Promise<string | null> => {
      const res = await this.opts.tmux(['capture-pane', '-p', '-e', '-J', '-t', id, '-S', '-2000']);
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

  async kill(id: string): Promise<'ok'> {
    const session = this.sessions.get(id);
    if (session) {
      try { session.pty?.kill(); } catch { /* already dead */ }
      session.pty = null;
      this.exiting(session);
    }
    try {
      await this.opts.tmux(['kill-session', '-t', id]);
    } catch {
      // best effort: the registry is consistent without the tmux call
    }
    return 'ok';
  }

  async stopAll(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      try { session.pty?.kill(); } catch { /* already dead */ }
      session.pty = null;
      // Tombstone + drain waiters: parked readers resolve with eof instead
      // of winding up their hold timers after shutdown.
      this.exiting(session);
    }
  }

  /** Register an unknown id as a fresh Session when tmux says it is alive. */
  private async adoptIfLive(id: string, createdAt?: number): Promise<Session | null> {
    const res = await this.opts.tmux(['has-session', '-t', id]);
    if (res.code !== 0) return null;
    const now = this.now();
    const session: Session = {
      id,
      name: id,
      cols: 80,
      rows: 24,
      createdAt: createdAt ?? now,
      lastActiveAt: now,
      pty: null,
      seq: 1,
      ring: [],
      ringBytesUsed: 0,
      clients: 0,
      waiters: [],
      eofSignaled: false,
    };
    this.sessions.set(id, session);
    return session;
  }

  private newId(): string {
    let id = SESSION_PREFIX + randomBytes(3).toString('hex');
    while (this.sessions.has(id)) id = SESSION_PREFIX + randomBytes(3).toString('hex');
    return id;
  }

  private async liveSessions(): Promise<Array<{ id: string; created: number | null }>> {
    const res = await this.opts.tmux(['ls']);
    if (res.code !== 0 || !res.stdout.trim()) return [];
    const out: Array<{ id: string; created: number | null }> = [];
    for (const line of res.stdout.split('\n')) {
      const idMatch = /^([^\s:]+):/.exec(line);
      const id = idMatch?.[1];
      if (!id || !id.startsWith(SESSION_PREFIX)) continue;
      const createdMatch = /\(created (\d+)\)/.exec(line);
      out.push({
        id,
        created: createdMatch ? Number(createdMatch[1]) * 1000 : null,
      });
    }
    return out;
  }

  private attachPty(session: Session): void {
    if (session.pty) return;
    const env: Record<string, string> = {};
    for (const key of ENV_PASSTHROUGH) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    env.TERM = 'xterm-256color';
    const pty = this.opts.spawner('tmux', ['attach', '-t', session.id], {
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
      // Only detach here: eof is decided against tmux (has-session), not the
      // pty. Identity check: a stale exit must not null a replacement pty.
      if (session.pty === pty) session.pty = null;
    });
  }

  private exiting(session: Session): void {
    session.eofSignaled = true;
    if (this.sessions.delete(session.id) && !this.tombstones.some((t) => t.id === session.id)) {
      this.tombstones.push({ id: session.id, name: session.name, at: this.now(), createdAt: session.createdAt });
    }
    this.wake(session);
  }

  private wake(session: Session): void {
    const waiters = session.waiters;
    session.waiters = [];
    for (const waiter of waiters) waiter();
  }
}
