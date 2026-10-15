import { getEventListeners } from 'node:events';
import { describe, expect, it } from 'vitest';
import { watchStream, WatchdogAbort, WatchdogTimeout } from './watchdog.js';

/** Synthetic generators only — the watchdog must never depend on a model. */

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
}

function drip(intervalMs: number, items: number[], opts?: { onReturn?: () => void }): AsyncIterable<number> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      return {
        next() {
          return new Promise<IteratorResult<number>>((resolve) => {
            if (i >= items.length) return resolve({ value: undefined, done: true });
            timer = setTimeout(() => resolve({ value: items[i++], done: false }), intervalMs);
          });
        },
        return() {
          if (timer) clearTimeout(timer);
          opts?.onReturn?.();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

async function collectError(source: AsyncIterable<number>): Promise<{ items: number[]; error: unknown }> {
  const items: number[] = [];
  try {
    for await (const item of source) items.push(item);
  } catch (error) {
    return { items, error };
  }
  return { items, error: null };
}

describe('watchStream', () => {
  it('passes a healthy stream through unchanged', async () => {
    const out = await collect(watchStream(drip(5, [1, 2, 3]), { firstChunkMs: 500, chunkGapMs: 500, totalMs: 5_000 }));
    expect(out).toEqual([1, 2, 3]);
  });

  it('throws first_chunk when the stream starts late, and cancels the source', async () => {
    let returned = false;
    const source = drip(500, [1], { onReturn: () => { returned = true; } });
    const { error } = await collectError(watchStream(source, { firstChunkMs: 150, chunkGapMs: 1_000, totalMs: 5_000 }));
    expect(error).toBeInstanceOf(WatchdogTimeout);
    expect((error as WatchdogTimeout).kind).toBe('first_chunk');
    expect(returned).toBe(true); // cancellation propagated upstream
  });

  it('throws chunk_gap after a mid-stream stall, keeping delivered items', async () => {
    const source = (async function* () {
      yield 1;
      yield 2;
      await new Promise((r) => setTimeout(r, 500)); // the stall
      yield 3;
    })();
    const { items, error } = await collectError(
      watchStream(source, { firstChunkMs: 500, chunkGapMs: 150, totalMs: 5_000 }),
    );
    expect(items).toEqual([1, 2]);
    expect(error).toBeInstanceOf(WatchdogTimeout);
    expect((error as WatchdogTimeout).kind).toBe('chunk_gap');
  });

  it('throws total on an infinite drip — output never extends the absolute cap', async () => {
    const source = drip(40, Array.from({ length: 10_000 }, (_, i) => i));
    const started = Date.now();
    const { items, error } = await collectError(
      watchStream(source, { firstChunkMs: 500, chunkGapMs: 500, totalMs: 200 }),
    );
    expect(error).toBeInstanceOf(WatchdogTimeout);
    expect((error as WatchdogTimeout).kind).toBe('total');
    expect(items.length).toBeLessThanOrEqual(5);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not accumulate abort listeners across chunks', async () => {
    const controller = new AbortController();
    const out = await collect(watchStream(
      drip(3, Array.from({ length: 25 }, (_, i) => i)),
      { firstChunkMs: 500, chunkGapMs: 500, totalMs: 5_000 },
      controller.signal,
    ));
    expect(out).toHaveLength(25);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  it('honors an external AbortSignal distinctly from timeouts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    const { error } = await collectError(
      watchStream(drip(1_000, [1]), { firstChunkMs: 5_000, chunkGapMs: 5_000, totalMs: 30_000 }, controller.signal),
    );
    expect(error).toBeInstanceOf(WatchdogAbort);
  });

  it('an already-aborted signal rejects before the first pull', async () => {
    const controller = new AbortController();
    controller.abort();
    let pulled = false;
    const source = (async function* () { pulled = true; yield 1; })();
    await expect(collect(watchStream(source, { firstChunkMs: 100, chunkGapMs: 100, totalMs: 100 }, controller.signal)))
      .rejects.toBeInstanceOf(WatchdogAbort);
    expect(pulled).toBe(false);
  });
});
