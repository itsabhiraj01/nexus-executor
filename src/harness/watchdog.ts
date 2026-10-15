/**
 * Model-stream watchdog (spec §Reliability rules). Three independent budgets:
 *
 * - `firstChunkMs` — the stream must produce its first item in time;
 * - `chunkGapMs`   — silence between items is bounded;
 * - `totalMs`      — ABSOLUTE cap for the whole stream; item delivery never
 *                    extends it (a chatty-forever stream is still killed).
 *
 * On any loss the upstream iterator is cancelled (`return()`) BEFORE the
 * error is thrown, so the producer observes real backpressure/cancellation —
 * the same discipline as tool-runner: never an abandoned background promise.
 * An external AbortSignal maps to WatchdogAbort, distinct from a stall: a
 * cancelled RUN is not a hung model.
 */

export type WatchdogKind = 'first_chunk' | 'chunk_gap' | 'total';

export class WatchdogTimeout extends Error {
  constructor(readonly kind: WatchdogKind) {
    super(`watchdog: ${kind}`);
    this.name = 'WatchdogTimeout';
  }
}

export class WatchdogAbort extends Error {
  constructor() {
    super('watchdog: aborted');
    this.name = 'WatchdogAbort';
  }
}

export interface WatchdogBudgets {
  firstChunkMs: number;
  chunkGapMs: number;
  totalMs: number;
}

type RaceOutcome<T> =
  | { kind: 'item'; result: IteratorResult<T> }
  | { kind: 'timeout'; timeoutKind: WatchdogKind }
  | { kind: 'aborted' };

export async function* watchStream<T>(
  source: AsyncIterable<T>,
  budgets: WatchdogBudgets,
  signal?: AbortSignal,
): AsyncIterable<T> {
  if (signal?.aborted) throw new WatchdogAbort();
  const iterator = source[Symbol.asyncIterator]();
  const startedAt = Date.now();
  let first = true;

  // ONE abort promise for the whole stream (a per-chunk listener would
  // accumulate: N chunks = N listeners on the run's shared signal), and it is
  // removed on exit — `once: true` only self-removes WHEN FIRED, so a never-
  // aborted run would otherwise leave it parked on the long-lived controller.
  let onAbort: (() => void) | null = null;
  const abortPromise = signal
    ? new Promise<RaceOutcome<T>>((resolve) => {
      onAbort = () => resolve({ kind: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
    })
    : null;

  try {
    for (;;) {
      const gapBudget = first ? budgets.firstChunkMs : budgets.chunkGapMs;
      const totalLeft = budgets.totalMs - (Date.now() - startedAt);
      if (totalLeft <= 0) throw new WatchdogTimeout('total');

      let timer: ReturnType<typeof setTimeout> | null = null;
      const racers: Promise<RaceOutcome<T>>[] = [
        iterator.next().then((result): RaceOutcome<T> => ({ kind: 'item', result })),
        new Promise<RaceOutcome<T>>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              kind: 'timeout',
              timeoutKind: Date.now() - startedAt >= budgets.totalMs
                ? 'total'
                : first ? 'first_chunk' : 'chunk_gap',
            });
          }, Math.min(gapBudget, totalLeft));
        }),
      ];
      if (abortPromise) racers.push(abortPromise);
      const outcome = await Promise.race(racers).finally(() => {
        if (timer) clearTimeout(timer);
      });

      if (outcome.kind === 'aborted') {
        await iterator.return?.();
        throw new WatchdogAbort();
      }
      if (outcome.kind === 'timeout') {
        await iterator.return?.();
        throw new WatchdogTimeout(outcome.timeoutKind);
      }
      if (outcome.result.done) return;
      first = false;
      yield outcome.result.value;
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    // Any exit path — exhaustion, our own throw, consumer break — closes the
    // source rather than orphaning it.
    await iterator.return?.();
  }
}
