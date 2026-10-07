/**
 * Fixed-window rate limiter with an LRU-capped in-memory Map — copied
 * verbatim from the hub's `packages/platform/auth/src/rate-limit.ts`.
 * Not shared across processes; sufficient at this executor's scale.
 */
type Bucket = { count: number; resetAt: number };

export class RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  // Map preserves insertion order; on eviction we drop the oldest key.
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: { max: number; windowMs: number; maxKeys?: number }) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  hit(key: string): { allowed: boolean; retryAfterSeconds?: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (bucket) {
      // LRU touch: delete + re-insert so recently-hit keys are most-recent.
      this.buckets.delete(key);
      if (bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + this.windowMs };
      }
    } else {
      bucket = { count: 0, resetAt: now + this.windowMs };
    }
    bucket.count += 1;
    this.buckets.set(key, bucket);
    this.evictIfOverCap();
    if (bucket.count > this.max) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }
    return { allowed: true };
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  size(): number {
    return this.buckets.size;
  }

  private evictIfOverCap(): void {
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}
