import type {
  AlgorithmFn,
  FixedWindowConfig,
  RateLimitResult,
  StoredState,
} from "../types";

interface FixedWindowState extends StoredState {
  count: number;
  windowStart: number;
}

export const fixedWindow: AlgorithmFn<FixedWindowConfig> = (
  config,
  current,
  nowMs
): { state: StoredState; result: RateLimitResult } => {
  const { limit, windowMs } = config;
  const prev = current as FixedWindowState | null;

  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const windowEnd = windowStart + windowMs;
  const resetMs = windowEnd - nowMs;

  const count = prev && prev.windowStart === windowStart ? prev.count : 0;

  if (count >= limit) {
    return {
      state: { count, windowStart } satisfies FixedWindowState,
      result: {
        allowed: false,
        limit,
        remaining: 0,
        resetMs,
        retryAfterMs: resetMs,
      },
    };
  }

  const newCount = count + 1;

  return {
    state: { count: newCount, windowStart } satisfies FixedWindowState,
    result: {
      allowed: true,
      limit,
      remaining: limit - newCount,
      resetMs,
      retryAfterMs: 0,
    },
  };
};
