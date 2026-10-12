import { describe, expect, it } from 'vitest';
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

export function fakeTmux(state: { sessions: Map<string, { cols: number; rows: number; created: number }> }): TmuxRunner {
  return async (args: string[]) => {
    if (args[0] === 'new-session') {
      const name = args[args.indexOf('-s') + 1];
      state.sessions.set(name, { cols: Number(args[args.indexOf('-x') + 1]), rows: Number(args[args.indexOf('-y') + 1]), created: 1_700_000_000 });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'has-session') return { code: state.sessions.has(args[args.indexOf('-t') + 1]) ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'ls') {
      const rows = [...state.sessions.entries()].map(([id]) => `${id}: 1 windows (created 1700000000)`).join('\n');
      return { code: 0, stdout: rows, stderr: '' };
    }
    if (args[0] === 'capture-pane') return { code: 0, stdout: 'SNAPSHOT-TEXT\n', stderr: '' };
    if (args[0] === 'kill-session') { state.sessions.delete(args[args.indexOf('-t') + 1]); return { code: 0, stdout: '', stderr: '' }; }
    throw new Error(`unexpected tmux args ${args.join(' ')}`);
  };
}

function makeRegistry(opts: { maxSessions?: number } = {}) {
  const tmuxState = { sessions: new Map<string, { cols: number; rows: number; created: number }>() };
  const ptys: FakePty[] = [];
  const registry = new TerminalRegistry({
    tmux: fakeTmux(tmuxState),
    spawner: () => { const p = new FakePty(); ptys.push(p); return p; },
    tmuxAvailable: async () => true,
    maxSessions: opts.maxSessions,
  });
  return { registry, tmuxState, ptys };
}

describe('TerminalRegistry', () => {
  it('creates a tmux session and attaches a pty client', async () => {
    const { registry, tmuxState, ptys } = makeRegistry();
    const created = await registry.create({ cols: 120, rows: 30, name: 'dev' });
    expect(created.name).toBe('dev');
    expect([...tmuxState.sessions.keys()]).toEqual([created.id]);
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

  it('enforces the session cap', async () => {
    const { registry } = makeRegistry({ maxSessions: 1 });
    await registry.create({ cols: 80, rows: 24 });
    await expect(registry.create({ cols: 80, rows: 24 })).rejects.toThrow(/limit reached/i);
  });

  it('long-poll resolves early when data arrives; eof flows once the shell exits', async () => {
    const tmuxState = { sessions: new Map<string, { cols: number; rows: number; created: number }>() };
    const ptys: FakePty[] = [];
    const registry = new TerminalRegistry({
      tmux: fakeTmux(tmuxState),
      spawner: () => { const p = new FakePty(); ptys.push(p); return p; },
      tmuxAvailable: async () => true,
    });
    const { id } = await registry.create({ cols: 80, rows: 24 });
    const pending = registry.read(id, 1, 5_000, false);
    setTimeout(() => ptys[0].emit('late\n'), 10);
    const res = await pending;
    expect(res!.chunks.map((c) => c.data).join('')).toBe('late\n');
    ptys[0].kill();
    tmuxState.sessions.delete(id); // tmux knows before our eof flag
    const info = await registry.list();
    expect(info.sessions.find((s) => s.id === id)?.status).toBe('exited');
    expect(await registry.kill(id)).toBe('ok'); // idempotent
  });

  it('seeds a snapshot on attach when the ring is empty (post-restart sound)', async () => {
    const { registry, tmuxState } = makeRegistry();
    tmuxState.sessions.set('nxt-old1', { cols: 80, rows: 24, created: 1_700_000_000 });
    const list = await registry.list();
    expect(list.sessions.some((s) => s.id === 'nxt-old1')).toBe(true);
    const res = await registry.read('nxt-old1', 0, 0, true);
    expect(res!.snapshot).toBe('SNAPSHOT-TEXT\n');
  });

  it('delivers the attach snapshot immediately instead of long-polling it away', async () => {
    const { registry, tmuxState } = makeRegistry();
    tmuxState.sessions.set('nxt-snap1', { cols: 80, rows: 24, created: 1_700_000_000 });
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
    const tmuxState = { sessions: new Map<string, { cols: number; rows: number; created: number }>() };
    const ptys: FakePty[] = [];
    const registry = new TerminalRegistry({
      tmux: fakeTmux(tmuxState),
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
    const tmuxState = { sessions: new Map<string, { cols: number; rows: number; created: number }>() };
    const registry = new TerminalRegistry({
      tmux: fakeTmux(tmuxState),
      spawner: () => new FakePty(),
      tmuxAvailable: async () => true,
    });
    const { id } = await registry.create({ cols: 80, rows: 24 });
    const pending = registry.read(id, 1, 5_000, false);
    tmuxState.sessions.delete(id); // the shell died; tmux already knows
    const [res] = await Promise.all([pending, registry.list()]);
    expect(res).not.toBeNull();
    expect(res!.eof).toBe(true);
    expect(res!.status).toBe('exited');
  });

  it('adopts a surviving tmux session on first read (restart-proof reattach)', async () => {
    const { registry, tmuxState } = makeRegistry();
    tmuxState.sessions.set('nxt-alive1', { cols: 80, rows: 24, created: 1_700_000_000 });
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
