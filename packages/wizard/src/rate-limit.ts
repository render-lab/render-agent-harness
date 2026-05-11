/**
 * In-memory token-bucket rate limiter, keyed by client IP. Survives a
 * single-instance Render pserv; when we scale-out the wizard, move to
 * a KV-backed store with the same interface.
 */

export interface RateLimiterOpts {
  /** Max requests in the window. */
  capacity: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Override for testing (Date.now by default). */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  refillAt: number;
}

export interface RateLimiter {
  /** Returns true if the request is allowed (and consumes a token). */
  consume(key: string): boolean;
  /** Returns the current bucket state for a key (testing aid). */
  inspect(key: string): { tokens: number; refillAt: number } | null;
}

export function createRateLimiter(opts: RateLimiterOpts): RateLimiter {
  const buckets = new Map<string, Bucket>();
  const now = opts.now ?? (() => Date.now());

  return {
    consume(key: string): boolean {
      const t = now();
      let bucket = buckets.get(key);
      if (!bucket || t >= bucket.refillAt) {
        bucket = { tokens: opts.capacity, refillAt: t + opts.windowMs };
        buckets.set(key, bucket);
      }
      if (bucket.tokens <= 0) return false;
      bucket.tokens -= 1;
      return true;
    },
    inspect(key: string) {
      const b = buckets.get(key);
      if (!b) return null;
      return { tokens: b.tokens, refillAt: b.refillAt };
    },
  };
}
