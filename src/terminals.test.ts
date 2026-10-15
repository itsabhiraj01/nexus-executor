import { describe, expect, it } from 'vitest';
import type { TerminalSessionRecord } from './terminal-store.js';
import {
  TerminalRegistry, TerminalTmuxError, type PtyProcess, type TmuxRunner,
} from './terminals.js';

class FakePty implements PtyProcess {
  data: string[] = [];
  killed = false;
  sizes: Array<{ cols: number; rows: number }> = [];
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  write(d: string): void { this.data.push(d); }
  resize(cols: number, rows: number): void { this.sizes.push({ cols, rows }); }
  kill(): void { this.killed = true; this.exitCb?.({ exitCode: 0 }); }
  onData(cb: (d: string) => void): void { this.dataCb = cb; }
  onExit(cb: (e: { exitCode: number }) => void): void { this.exitCb = cb; }
  emit(d: string): void { this.dataCb?.(d); } // test driver
}

/** The wire field separator: tmux renders our raw 0x1f format byte as its
 *  own escape text `\037` — the fake speaks the same wire format. */
const SEP = '\\037';

function escapeName(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\x1f/g, SEP);
}

export interface FakeTmuxSession {
  name: string;
  cols: number;
  rows: number;
  /** session_created, epoch SECONDS (tmux-native precision). */
  created: number;
  attached: number;
}

export interface FakeTmuxState {
  /** Keyed by the NATIVE id ($N) — names live on the row and are mutable. */
  sessions: Map<string, FakeTmuxSession>;
  nextId: number;
  serverKey: string;
  /** Simulate a dead tmux server: scan/probe fail like the real thing. */
  serverDown: boolean;
  /** Simulate a wedged tmux: every call times out. */
  wedged: boolean;
}

export function makeTmuxState(serverKey = '/tmp/fake-tmux/default#1791819000.4020501'): FakeTmuxState {
  return { sessions: new Map(), nextId: 0, serverKey, serverDown: false, wedged: false };
}

/** Add a session the way tmux would report it after `tmux new-session`;
 *  returns the native $id. */
export function putTmuxSession(
  state: FakeTmuxState, name: string,
  opts: { cols?: number; rows?: number; created?: number; attached?: number } = {},
): string {
  const id = `$${state.nextId++}`;
  state.sessions.set(id, {
    name, cols: opts.cols ?? 80, rows: opts.rows ?? 24,
    created: opts.created ?? 1_791_819_000, attached: opts.attached ?? 0,
  });
  return id;
}

function findByNameOrId(state: FakeTmuxState, target: string): string | null {
  if (state.sessions.has(target)) return target;
  for (const [id, session] of state.sessions) {
    if (session.name === target || id === target) return id;
  }
  return null;
}

export function fakeTmux(state: FakeTmuxState): TmuxRunner {
  return async (args: string[]) => {
    if (state.wedged) return { code: 124, stdout: '', stderr: 'tmux timed out' };
    if (args[0] === 'new-session') {
      if (state.serverDown) return { code: 1, stdout: '', stderr: 'no server running on /tmp/fake-tmux/default' };
      const name = args[args.indexOf('-s') + 1]!;
      if (findByNameOrId(state, name)) return { code: 1, stdout: '', stderr: 'duplicate session' };
      state.serverDown = false;
      const id = putTmuxSession(state, name, {
        cols: Number(args[args.indexOf('-x') + 1]),
        rows: Number(args[args.indexOf('-y') + 1]),
      });
      const session = state.sessions.get(id)!;
      return { code: 0, stdout: `${id}${SEP}${session.created}\n`, stderr: '' };
    }
    if (args[0] === 'list-sessions') {
      if (state.serverDown) return { code: 1, stdout: '', stderr: 'no server running on /tmp/fake-tmux/default' };
      const lines = [...state.sessions.entries()].map(([id, s]) =>
        [id, escapeName(s.name), String(s.created), String(s.created), String(s.cols), String(s.rows), String(s.attached)].join(SEP),
      ).join('\n');
      return { code: 0, stdout: lines ? `${lines}\n` : '', stderr: '' };
    }
    if (args[0] === 'display-message') {
      if (state.serverDown) return { code: 1, stdout: '', stderr: 'no server running on /tmp/fake-tmux/default' };
      const [socket, rest] = state.serverKey.split('#') as [string, string];
      const [start, pid] = rest.split('.') as [string, string];
      return { code: 0, stdout: `${pid}${SEP}${start}${SEP}${socket}\n`, stderr: '' };
    }
    if (args[0] === 'capture-pane') {
      return findByNameOrId(state, args[args.indexOf('-t') + 1]!)
        ? { code: 0, stdout: 'SNAPSHOT-TEXT\n', stderr: '' }
        : { code: 1, stdout: '', stderr: "can't find session" };
    }
    if (args[0] === 'kill-session') {
      const id = findByNameOrId(state, args[args.indexOf('-t') + 1]!);
      if (id) state.sessions.delete(id);
      return { code: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected tmux args ${args.join(' ')}`);
  };
}

/** A structural fake of the DURABLE half — what a second registry instance
 *  (post-restart) re-reads. Real-PG behavior is pinned in
 *  terminal-store.test.ts; this pins the registry's USE of the store. */
export class FakeTerminalStore {
  rows = new Map<string, TerminalSessionRecord>();
  byIdentity = new Map<string, string>(); // triple key → public id
  upsertCalls = 0;
  failNextUpsert: Error | null = null;

  private tripleKey(server: string, sessionId: string, createdAt: Date): string {
    return `${server}||${sessionId}||${createdAt.getTime()}`;
  }

  async upsertLive(input: {
    identity: { server: string; sessionId: string; createdAt: Date };
    tmuxName: string; candidatePublicId: string | null; mintPublicId: () => string;
    origin: 'created' | 'imported'; displayName?: string; lastActiveAt?: Date; now: Date;
  }): Promise<TerminalSessionRecord> {
    this.upsertCalls += 1;
    if (this.failNextUpsert) { const e = this.failNextUpsert; this.failNextUpsert = null; throw e; }
    const key = this.tripleKey(input.identity.server, input.identity.sessionId, input.identity.createdAt);
    const existingId = this.byIdentity.get(key);
    if (existingId) {
      const row = this.rows.get(existingId)!;
      row.tmuxName = input.tmuxName;
      if (row.origin === 'imported') row.name = input.tmuxName;
      row.lastSeenAt = input.now;
      if (input.lastActiveAt && input.lastActiveAt > row.lastActiveAt) row.lastActiveAt = input.lastActiveAt;
      row.exitedAt = null;
      return row;
    }
    let publicId = input.candidatePublicId ?? input.mintPublicId();
    while (this.rows.has(publicId)) publicId = input.mintPublicId();
    const row: TerminalSessionRecord = {
      publicId,
      tmuxServer: input.identity.server,
      tmuxSessionId: input.identity.sessionId,
      tmuxCreatedAt: input.identity.createdAt,
      tmuxName: input.tmuxName,
      name: input.origin === 'imported' ? input.tmuxName : (input.displayName ?? input.tmuxName),
      origin: input.origin,
      createdAt: input.now,
      lastActiveAt: input.lastActiveAt ?? input.now,
      lastSeenAt: input.now,
      exitedAt: null,
    };
    this.rows.set(publicId, row);
    this.byIdentity.set(key, publicId);
    return row;
  }

  async markExited(publicId: string, at: Date): Promise<void> {
    const row = this.rows.get(publicId);
    if (row && !row.exitedAt) row.exitedAt = at;
  }

  async markMissingExited(keepPublicIds: string[], at: Date): Promise<TerminalSessionRecord[]> {
    const transitioned: TerminalSessionRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.exitedAt || keepPublicIds.includes(row.publicId)) continue;
      row.exitedAt = at;
      transitioned.push(row);
    }
    return transitioned;
  }

  async recentlyExited(since: Date): Promise<TerminalSessionRecord[]> {
    return [...this.rows.values()].filter((row) => row.exitedAt && row.exitedAt >= since);
  }
}

function makeRegistry(
  opts: { maxSessions?: number; store?: FakeTerminalStore | null; state?: FakeTmuxState } = {},
) {
  const state = opts.state ?? makeTmuxState();
  const ptys: FakePty[] = [];
  const registry = new TerminalRegistry({
    tmux: fakeTmux(state),
    spawner: () => { const p = new FakePty(); ptys.push(p); return p; },
    tmuxAvailable: async () => true,
    store: opts.store as unknown as import('./terminal-store.js').TerminalStore | undefined ?? undefined,
    maxSessions: opts.maxSessions,
  });
  return { registry, state, ptys };
}

describe('TerminalRegistry — core streaming behavior', () => {
  it('creates a tmux session and attaches a pty client', async () => {
    const { registry, state, ptys } = makeRegistry();
    const created = await registry.create({ cols: 120, rows: 30, name: 'dev' });
    expect(created.name).toBe('dev');
    const ids = [...state.sessions.values()].map((s) => s.name);
    expect(ids).toEqual([created.id]);
    expect(created.id).toMatch(/^nxt-/);
    expect(ptys).toHaveLength(1);
  });

  it('streams output chunks with monotonic seqs and replays since a cursor', async () => {
    const { registry, ptys } = makeRegistry();
    const { id } = await registry.create({ cols: 80, rows: 24 });
    ptys[0].emit('$ ls\nfoo\n');
    ptys[0].emit('bar\n');
    const first = await registry.read(id, 0, 0, false);
    expect(first).not.toBeNull();
    expect(first!.chunks.map((c) => c.data).join('')).toBe('$ ls\nfoo\nbar\n');
    const second = await registry.read(id, first!.seq, 0, false);
    expect(second!.chunks).toEqual([]);
    expect(second!.seq).toBe(first!.seq);
  });

  it('routes input and resize to the pty', async () => {
    const { registry, ptys } = makeRegistry();
    const { id } = await registry.create({ cols: 80, rows: 24 });
    expect(registry.input(id, 'echo hi\n')).toBe('ok');
    expect(ptys[0].data).toEqual(['echo hi\n']);
    expect(registry.input('nxt-missing', 'x')).toBe('not_found');
    expect(registry.resize(id, 120, 40)).toBe('ok');
    expect(ptys[0].sizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it('enforces the session cap — imported sessions count toward it', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 'manual-dev'); // the operator's own session
    const { registry } = makeRegistry({ maxSessions: 1, state });
    const listed = await registry.list(); // imports past the cap — never refused
    expect(listed.sessions).toHaveLength(1);
    await expect(registry.create({ cols: 80, rows: 24 })).rejects.toThrow(/limit reached/i);
  });

  it('long-poll resolves early when data arrives; eof flows once the shell exits', async () => {
    const state = makeTmuxState();
    const ptys: FakePty[] = [];
    const registry = new TerminalRegistry({
      tmux: fakeTmux(state),
      spawner: () => { const p = new FakePty(); ptys.push(p); return p; },
      tmuxAvailable: async () => true,
    });
    const { id } = await registry.create({ cols: 80, rows: 24 });
    const pending = registry.read(id, 1, 5_000, false);
    setTimeout(() => ptys[0].emit('late\n'), 10);
    const res = await pending;
    expect(res!.chunks.map((c) => c.data).join('')).toBe('late\n');
    ptys[0].kill();
    state.sessions.clear(); // tmux knows before our eof flag
    const info = await registry.list();
    expect(info.sessions.find((s) => s.id === id)?.status).toBe('exited');
    expect(await registry.kill(id)).toBe('ok'); // idempotent
  });

  it('seeds a snapshot on attach when the ring is empty (post-restart sound)', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 'nxt-old1');
    const { registry } = makeRegistry({ state });
    const list = await registry.list();
    expect(list.sessions.some((s) => s.id === 'nxt-old1')).toBe(true);
    const res = await registry.read('nxt-old1', 0, 0, true);
    expect(res!.snapshot).toBe('SNAPSHOT-TEXT\n');
  });

  it('delivers the attach snapshot immediately instead of long-polling it away', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 'nxt-snap1');
    const { registry } = makeRegistry({ state });
    await registry.list(); // adopt the pre-existing tmux session
    const started = Date.now();
    const res = await registry.read('nxt-snap1', 0, 5_000, true);
    expect(Date.now() - started).toBeLessThan(1_000); // not the full 5s hold
    expect(res!.snapshot).toBe('SNAPSHOT-TEXT\n');
    expect(res!.chunks).toHaveLength(0);
  });

  it('rejects with TerminalTmuxError when tmux new-session fails', async () => {
    const registry = new TerminalRegistry({
      tmux: async () => ({ code: 1, stdout: '', stderr: 'no server running on /tmp/tmux-1000/default' }),
      spawner: () => new FakePty(),
      tmuxAvailable: async () => true,
    });
    await expect(registry.create({ cols: 80, rows: 24 })).rejects.toThrow(TerminalTmuxError);
    // a rejected create must not poison later ones (chain stays alive)
    const seq = registry.create({ cols: 80, rows: 24 });
    await expect(seq).rejects.toThrow(TerminalTmuxError);
  });

  it('resyncs with a snapshot when the cursor fell behind the retained window', async () => {
    const state = makeTmuxState();
    const ptys: FakePty[] = [];
    const registry = new TerminalRegistry({
      tmux: fakeTmux(state),
      spawner: () => { const p = new FakePty(); ptys.push(p); return p; },
      tmuxAvailable: async () => true,
      ringBytes: 16, // retain only the last couple of ~7-byte chunks
    });
    const { id } = await registry.create({ cols: 80, rows: 24 });
    for (let i = 0; i < 10; i += 1) ptys[0].emit(`line-${i}\n`);
    const res = await registry.read(id, 1, 0, false);
    expect(res).not.toBeNull();
    expect(res!.chunks).toEqual([]);
    expect(res!.snapshot).toBe('SNAPSHOT-TEXT\n');
  });

  it('wakes a parked long-poll when the session exits (eof against tmux)', async () => {
    const state = makeTmuxState();
    const registry = new TerminalRegistry({
      tmux: fakeTmux(state),
      spawner: () => new FakePty(),
      tmuxAvailable: async () => true,
    });
    const { id } = await registry.create({ cols: 80, rows: 24 });
    const pending = registry.read(id, 1, 5_000, false);
    state.sessions.clear(); // the shell died; tmux already knows
    const [res] = await Promise.all([pending, registry.list()]);
    expect(res).not.toBeNull();
    expect(res!.eof).toBe(true);
    expect(res!.status).toBe('exited');
  });

  it('adopts a surviving tmux session on first read (restart-proof reattach)', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 'nxt-alive1');
    const { registry } = makeRegistry({ state });
    // no list() first: the read itself must heal the post-restart registry
    const res = await registry.read('nxt-alive1', 0, 0, true);
    expect(res).not.toBeNull();
    expect(res!.snapshot).toBe('SNAPSHOT-TEXT\n');
    expect(registry.input('nxt-alive1', 'x')).toBe('ok');
  });

  it('returns null reading an id tmux does not know', async () => {
    const { registry } = makeRegistry();
    expect(await registry.read('nxt-dead9', 0, 0, true)).toBeNull();
  });
});

describe('TerminalRegistry — tmux-server sync (backfill)', () => {
  it('imports manually created sessions with stable minted ids and live attachment counts', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 'manual-dev', { attached: 1 });
    putTmuxSession(state, 'funky name x', { attached: 0 });
    const { registry } = makeRegistry({ state });
    const list = await registry.list();
    expect(list.sessions).toHaveLength(2);
    const manual = list.sessions.find((s) => s.name === 'manual-dev')!;
    expect(manual.id).toMatch(/^nxt-/);
    expect(manual.status).toBe('live');
    expect(manual.origin).toBe('imported');
    expect(manual.tmuxClients).toBe(1);
    const funky = list.sessions.find((s) => s.name === 'funky name x')!;
    expect(funky.tmuxClients).toBe(0);
    // A second sync (list) is idempotent — the same public ids come back.
    const again = await registry.list();
    expect(again.sessions.map((s) => s.id).sort()).toEqual(list.sessions.map((s) => s.id).sort());
  });

  it('keeps the existing nxt-* identity for sessions this executor made before', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 'nxt-abc123');
    const { registry } = makeRegistry({ state });
    const list = await registry.list();
    expect(list.sessions[0]!.id).toBe('nxt-abc123');
    expect(list.sessions[0]!.origin).toBe('imported'); // pre-store provenance is unknowable → imported
  });

  it('targets the NATIVE $id for capture/input/attach — never the mutable name', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 'manual-dev');
    const calls: string[][] = [];
    const registry = new TerminalRegistry({
      tmux: (args) => { calls.push(args); return fakeTmux(state)(args); },
      spawner: () => new FakePty(),
      tmuxAvailable: async () => true,
    });
    const list = await registry.list();
    const id = list.sessions[0]!.id;
    await registry.read(id, 0, 0, true);
    const capture = calls.find((a) => a[0] === 'capture-pane')!;
    expect(capture).toContain('$0');
    const attach = calls.find((a) => a[0] === 'attach');
    expect(attach).toBeUndefined(); // attach goes through the pty spawner, not the runner
    await registry.kill(id);
    const killed = calls.find((a) => a[0] === 'kill-session')!;
    expect(killed).toContain('$0');
  });

  it('a tmux RENAME keeps the public id (identity is the native $id + creation)', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 'manual-dev');
    const { registry, } = makeRegistry({ state });
    const first = await registry.list();
    const publicId = first.sessions[0]!.id;
    state.sessions.get('$0')!.name = 'maintenance';
    const second = await registry.list();
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0]!.id).toBe(publicId);
    expect(second.sessions[0]!.name).toBe('maintenance');
    // …and ops still land on the same tmux session.
    expect(registry.input(publicId, 'ls\n')).toBe('ok');
  });

  it('marks sessions exited when tmux loses them; a dead server tombstones everything', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 'manual-dev');
    putTmuxSession(state, 'manual-ops');
    const { registry } = makeRegistry({ state });
    await registry.list();
    state.sessions.delete('$1');
    const after = await registry.list();
    expect(after.sessions.find((s) => s.name === 'manual-dev')!.status).toBe('live');
    expect(after.sessions.find((s) => s.name === 'manual-ops')!.status).toBe('exited');
    // The whole server dies → everything (being truly gone) tombstones.
    state.sessions.clear();
    state.serverDown = true;
    const dead = await registry.list();
    expect(dead.sessions.every((s) => s.status === 'exited')).toBe(true);
  });

  it('FAILED scans (timeout/permission/malformed) throw WITHOUT marking sessions exited', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 'manual-dev');
    const { registry } = makeRegistry({ state });
    await registry.list();
    state.wedged = true;
    await expect(registry.list()).rejects.toThrow(TerminalTmuxError);
    state.wedged = false;
    const after = await registry.list();
    expect(after.sessions.find((s) => s.name === 'manual-dev')!.status).toBe('live');
  });

  it('rejects malformed inventory output instead of half-syncing', async () => {
    const garbage = new TerminalRegistry({
      tmux: async (args) => args[0] === 'list-sessions'
        ? { code: 0, stdout: 'this is not the escaped format\n', stderr: '' }
        : { code: 0, stdout: '4020501\\0371791819000\\037/tmp/sock\n', stderr: '' },
      spawner: () => new FakePty(),
      tmuxAvailable: async () => true,
    });
    await expect(garbage.list()).rejects.toThrow(TerminalTmuxError);
  });

  it('keeps recently-exited sessions listed for the ten-minute window', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 'manual-dev');
    const { registry } = makeRegistry({ state });
    const listed = await registry.list();
    const id = listed.sessions[0]!.id;
    state.sessions.clear();
    const after = await registry.list();
    expect(after.sessions.find((s) => s.id === id)!.status).toBe('exited');
  });

  it('serializes reconciliation with creation (no double registration)', async () => {
    const state = makeTmuxState();
    const store = new FakeTerminalStore();
    const { registry } = makeRegistry({ state, store });
    // The two scans and the create race in any order — the chain must
    // serialize them: exactly one row lands and no scan throws.
    const [, , c] = await Promise.all([registry.list(), registry.list(), registry.create({ cols: 80, rows: 24 })]);
    expect(store.rows.size).toBe(1); // the created session — exactly one row
    expect([...store.rows.keys()][0]).toBe(c.id);
    const settled = await registry.list();
    expect(settled.sessions.map((s) => s.id)).toEqual([c.id]);
    // A mid-list retried create is answered by the chain as ONE session.
    const [created, , retried] = await Promise.all([
      registry.create({ cols: 80, rows: 24, idempotencyKey: 'keykey1' }),
      registry.list(),
      registry.create({ cols: 80, rows: 24, idempotencyKey: 'keykey1' }),
    ]);
    expect(created.id).toBe('nxt-keykey1');
    expect(retried.id).toBe('nxt-keykey1');
    const all = await registry.list();
    expect(all.sessions.filter((s) => s.id === 'nxt-keykey1')).toHaveLength(1);
    expect(store.rows.size).toBe(2);
  });
});

describe('TerminalRegistry — durable store integration', () => {
  it('registers created sessions and restores them across a restart', async () => {
    const state = makeTmuxState();
    const store = new FakeTerminalStore();
    const first = makeRegistry({ state, store });
    const created = await first.registry.create({ cols: 100, rows: 40, name: 'dev' });
    expect(store.rows.get(created.id)).toMatchObject({ origin: 'created', name: 'dev', tmuxName: created.id });

    // "Restart": a fresh registry over the same tmux + store — and a second
    // MANUAL session that only the inventory knows.
    putTmuxSession(state, 'manual-dev');
    const second = makeRegistry({ state, store });
    const listed = await second.registry.list();
    const restored = listed.sessions.find((s) => s.id === created.id)!;
    expect(restored).toMatchObject({ status: 'live', origin: 'created', name: 'dev', cols: 100, rows: 40 });
    const manual = listed.sessions.find((s) => s.name === 'manual-dev')!;
    expect(manual.origin).toBe('imported');
    // The same public id answers reads — the mapping survived the restart.
    const res = await second.registry.read(created.id, 0, 0, true);
    expect(res!.snapshot).toBe('SNAPSHOT-TEXT\n');
  });

  it('a recycled $id after a tmux-server restart can never impersonate the old registration', async () => {
    const state = makeTmuxState('sock#1000.1');
    const store = new FakeTerminalStore();
    const first = makeRegistry({ state, store });
    const created = await first.registry.create({ cols: 80, rows: 24 });
    // The tmux SERVER restarts: identity flips; it hands out $0 again (same
    // native id, same name — but a different creation stamp).
    const fresh = makeTmuxState('sock#2000.2');
    fresh.nextId = 0;
    putTmuxSession(fresh, created.id, { created: 1_791_999_999 });
    const second = makeRegistry({ state: fresh, store });
    const listed = await second.registry.list();
    // The stale registration tombstones; the replacement gets a FRESH public id.
    const rows = [...store.rows.values()];
    expect(rows.find((r) => r.publicId === created.id)!.exitedAt).not.toBeNull();
    const replacement = listed.sessions.find((s) => s.status === 'live')!;
    expect(replacement.id).not.toBe(created.id);
    expect(replacement.name).toBe(created.id); // the tmux name walked free
    const exitedRow = listed.sessions.find((s) => s.id === created.id)!;
    expect(exitedRow.status).toBe('exited');
  });

  it('kill stamps the durable row; repeated kills stay idempotent', async () => {
    const state = makeTmuxState();
    const store = new FakeTerminalStore();
    const first = makeRegistry({ state, store });
    const created = await first.registry.create({ cols: 80, rows: 24 });
    expect(await first.registry.kill(created.id)).toBe('ok');
    expect(store.rows.get(created.id)!.exitedAt).not.toBeNull();
    expect(await first.registry.kill(created.id)).toBe('ok');
    // …and the tombstone is served by the next registry instance too.
    const second = makeRegistry({ state, store });
    const listed = await second.registry.list();
    expect(listed.sessions.find((s) => s.id === created.id)!.status).toBe('exited');
  });

  it('kills an imported session through its native id', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 'manual-dev');
    const store = new FakeTerminalStore();
    const { registry } = makeRegistry({ state, store });
    const listed = await registry.list();
    const id = listed.sessions[0]!.id;
    expect(await registry.kill(id)).toBe('ok');
    expect(state.sessions.size).toBe(0);
    expect(store.rows.get(id)!.exitedAt).not.toBeNull();
    expect(await registry.kill(id)).toBe('ok'); // idempotent
  });

  it('a store failure on create tears the fresh tmux session back down', async () => {
    const state = makeTmuxState();
    const store = new FakeTerminalStore();
    const { registry } = makeRegistry({ state, store });
    store.failNextUpsert = new Error('db gone');
    await expect(registry.create({ cols: 80, rows: 24 })).rejects.toThrow('db gone');
    expect(state.sessions.size).toBe(0); // no half-registration leaked
    expect(store.rows.size).toBe(0);
  });

  it('imported sessions past the cap are still listed; only new creates are refused', async () => {
    const state = makeTmuxState();
    putTmuxSession(state, 's1', {});
    putTmuxSession(state, 's2', {});
    const store = new FakeTerminalStore();
    const { registry } = makeRegistry({ state, store, maxSessions: 1 });
    const listed = await registry.list();
    expect(listed.sessions.filter((s) => s.status === 'live')).toHaveLength(2);
    expect(store.rows.size).toBe(2);
    await expect(registry.create({ cols: 80, rows: 24 })).rejects.toThrow(/limit reached/i);
  });
});
