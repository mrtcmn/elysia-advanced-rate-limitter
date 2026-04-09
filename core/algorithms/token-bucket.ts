import type {
  AlgorithmFn,
  RateLimitResult,
  StoredState,
  TokenBucketConfig,
} from "../types";

/**
 * GCRA (Generic Cell Rate Algorithm) — the gold standard for distributed
 * token bucket rate limiting. Used by Stripe, Cloudflare, Kong, Shopify.
 *
 * Mathematically equivalent to token bucket but stores a single number:
 * TAT (Theoretical Arrival Time) — the time when the bucket will be full.
 *
 * emissionIntervalMs = 1000 / refillRate  (ms between allowed requests)
 * burstOffsetMs = emissionIntervalMs * capacity  (max burst window)
 *
 * On each request:
 *   newTat = max(tat, now) + emissionIntervalMs
 *   allowAt = newTat - burstOffsetMs
 *   if now < allowAt → denied
 *   else → allowed, store newTat
 */

interface GCRAState extends StoredState {
  tat: number; // Theoretical Arrival Time (ms)
}

export const tokenBucket: AlgorithmFn<TokenBucketConfig> = (
  config,
  current,
  nowMs
): { state: StoredState; result: RateLimitResult } => {
  const { capacity, refillRate } = config;

  const emissionIntervalMs = 1000 / refillRate;
  const burstOffsetMs = emissionIntervalMs * capacity;

  const prev = current as GCRAState | null;
  const tat = prev?.tat ?? nowMs;

  const newTat = Math.max(tat, nowMs) + emissionIntervalMs;
  const allowAt = newTat - burstOffsetMs;

  if (nowMs < allowAt) {
    const retryAfterMs = Math.ceil(allowAt - nowMs);
    const resetMs = Math.ceil(tat - nowMs);

    return {
      state: { tat } satisfies GCRAState,
      result: {
        allowed: false,
        limit: capacity,
        remaining: 0,
        resetMs: Math.max(0, resetMs),
        retryAfterMs,
      },
    };
  }

  // Remaining = how many more requests fit before TAT exceeds burst window
  const remaining = Math.max(0, Math.floor((burstOffsetMs - (newTat - nowMs)) / emissionIntervalMs));
  const resetMs = Math.max(0, Math.ceil(newTat - nowMs));

  return {
    state: { tat: newTat } satisfies GCRAState,
    result: {
      allowed: true,
      limit: capacity,
      remaining,
      resetMs,
      retryAfterMs: 0,
    },
  };
};
