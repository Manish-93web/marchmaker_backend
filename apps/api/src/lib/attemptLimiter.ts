/**
 * Small fixed-window counter keyed by an arbitrary string (e.g. hashed email).
 * `hit` may be async so a shared (Redis) implementation can be used behind several API instances.
 */
export interface AttemptLimiter {
  /** Records an attempt and returns true while the key is still under the limit. */
  hit(key: string): boolean | Promise<boolean>;
  reset(key: string): void | Promise<void>;
}

export function memoryAttemptLimiter(limit: number, windowMs: number, now: () => number = Date.now): AttemptLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key) {
      const t = now();
      const b = buckets.get(key);
      if (!b || b.resetAt <= t) {
        buckets.set(key, { count: 1, resetAt: t + windowMs });
        return true;
      }
      b.count++;
      return b.count <= limit;
    },
    reset(key) {
      buckets.delete(key);
    },
  };
}

/** The few Redis commands the limiter needs, so tests can supply a fake. */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Counts attempts in Redis so every API instance shares one view. If Redis is unreachable it
 * falls back to a per-process counter: protection degrades, but it never switches off.
 */
export function redisAttemptLimiter(
  redis: RedisLike,
  prefix: string,
  limit: number,
  windowMs: number,
  onError?: (err: unknown) => void,
): AttemptLimiter {
  const fallback = memoryAttemptLimiter(limit, windowMs);
  return {
    async hit(key) {
      const k = `${prefix}:${key}`;
      try {
        const n = await redis.incr(k);
        // The window starts at the first attempt; later attempts do not extend it.
        if (n === 1) await redis.pexpire(k, windowMs);
        return n <= limit;
      } catch (err) {
        onError?.(err);
        return fallback.hit(key);
      }
    },
    async reset(key) {
      fallback.reset(key);
      try {
        await redis.del(`${prefix}:${key}`);
      } catch (err) {
        onError?.(err);
      }
    },
  };
}
