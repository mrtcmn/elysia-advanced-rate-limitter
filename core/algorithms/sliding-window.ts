import type {
  AlgorithmFn,
  RateLimitResult,
  SlidingWindowConfig,
  StoredState,
} from "../types";

/**
 * O(1) sliding window using the two-counter approximation.
 * Keeps counts for current + previous fixed window, then estimates
 * the sliding count as: previousCount * weight + currentCount
 * where weight = 1 - (elapsed in current window / windowMs).
 *
 * Space: O(1) per key (3 numbers vs. O(n) timestamps).
 * Time:  O(1) per check.
 */
interface SlidingWindowState extends StoredState {
  previousCount: number;
  currentCount: number;
  windowStart: number;
}

export const slidingWindow: AlgorithmFn<SlidingWindowConfig> = (
  config,
  current,
  nowMs
): { state: StoredState; result: RateLimitResult } => {
  const { limit, windowMs } = config;
  const prev = current as SlidingWindowState | null;

  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const elapsed = nowMs - windowStart;
  const weight = 1 - elapsed / windowMs;

  let previousCount: number;
  let currentCount: number;

  if (!prev) {
    previousCount = 0;
    currentCount = 0;
  } else if (prev.windowStart === windowStart) {
    // Same window — carry forward
    previousCount = prev.previousCount;
    currentCount = prev.currentCount;
  } else if (prev.windowStart === windowStart - windowMs) {
    // Rolled into next window — previous window's current becomes our previous
    previousCount = prev.currentCount;
    currentCount = 0;
  } else {
    // Stale state (>= 2 windows ago)
    previousCount = 0;
    currentCount = 0;
  }

  const estimated = Math.floor(previousCount * weight + currentCount);
  const resetMs = windowStart + windowMs - nowMs;

  if (estimated >= limit) {
    return {
      state: {
        previousCount,
        currentCount,
        windowStart,
      } satisfies SlidingWindowState,
      result: {
        allowed: false,
        limit,
        remaining: 0,
        resetMs: Math.max(0, resetMs),
        retryAfterMs: Math.max(0, resetMs),
      },
    };
  }

  currentCount += 1;
  const newEstimated = Math.floor(previousCount * weight + currentCount);
  const remaining = Math.max(0, limit - newEstimated);

  return {
    state: {
      previousCount,
      currentCount,
      windowStart,
    } satisfies SlidingWindowState,
    result: {
      allowed: true,
      limit,
      remaining,
      resetMs: Math.max(0, resetMs),
      retryAfterMs: 0,
    },
  };
};
