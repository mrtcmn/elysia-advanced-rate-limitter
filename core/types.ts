/**
 * Result returned by every rate limit check.
 * Exposed on every response via X-RateLimit-* headers.
 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetMs: number;
  retryAfterMs: number;
}

/** Opaque state blob persisted by the store adapter */
export type StoredState = Record<string, unknown>;

/**
 * Minimal storage contract.
 * - Memory adapter returns synchronously (no microtask overhead on Bun).
 * - Redis adapter returns Promises.
 * - Algorithms call via await which is a no-op on sync values.
 */
export interface RateLimitStore {
  get(key: string): Promise<StoredState | null> | StoredState | null;
  set(key: string, state: StoredState, ttlMs: number): Promise<void> | void;
  /**
   * Atomically check rate limit and update state.
   * Returns the rate limit decision.
   */
  check(
    key: string,
    config: AlgorithmConfig,
    nowMs: number,
    ttlMs: number
  ): Promise<RateLimitResult> | RateLimitResult;
}

/** Token Bucket: smooth rate with burst tolerance */
export interface TokenBucketConfig {
  algorithm: "token-bucket";
  capacity: number;
  refillRate: number;
}

/** Sliding Window: precise request counting */
export interface SlidingWindowConfig {
  algorithm: "sliding-window";
  limit: number;
  windowMs: number;
}

/** Fixed Window: simple counter per time block */
export interface FixedWindowConfig {
  algorithm: "fixed-window";
  limit: number;
  windowMs: number;
}

export type AlgorithmConfig =
  | TokenBucketConfig
  | SlidingWindowConfig
  | FixedWindowConfig;

/**
 * Algorithm function signature — pure transform.
 * Receives config + current stored state + current timestamp.
 * Returns new state to persist + the rate limit decision.
 */
export type AlgorithmFn<C extends AlgorithmConfig = AlgorithmConfig> = (
  config: C,
  current: StoredState | null,
  nowMs: number
) => { state: StoredState; result: RateLimitResult };

/** Extracts a string key from a request. Returns null to skip rate limiting. */
export type KeyResolver = (request: Request) => string | null;

/** Plugin options with sensible defaults */
export interface RateLimiterOptions {
  algorithm?: AlgorithmConfig;
  store?: RateLimitStore;
  keyResolver?: KeyResolver;
  errorResponse?: (result: RateLimitResult) => unknown;
  skip?: (request: Request) => boolean;
  prefix?: string;
}
