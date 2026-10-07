import type { JobEngine } from './engine.js';

/**
 * The poll worker — the same skeleton as the hub's builder worker:
 * `setInterval` with one tick in flight at a time, an immediate first tick,
 * every error reported through `onError` and nothing throwing past it.
 * Returns an async stop function.
 */
export function startWorker(
  engine: JobEngine,
  options: { onError: (error: unknown) => void },
): () => Promise<void> {
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const run = (): void => {
    if (stopped || inFlight) return;
    inFlight = engine
      .tick()
      .catch((error) => options.onError(error))
      .finally(() => {
        inFlight = null;
      });
  };

  run();
  const timer = setInterval(run, engine.config.pollIntervalMs);
  timer.unref();

  return async () => {
    stopped = true;
    clearInterval(timer);
    if (inFlight) await inFlight.catch(() => {});
    // Do not wait minutes for detached verification cycles on shutdown —
    // they are the agent's `sh -c`, not ours to block SIGTERM on.
    await Promise.race([
      engine.drain(),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000).unref()),
    ]);
  };
}
