import type {
  AlgorithmConfig,
  RateLimitResult,
  RateLimitStore,
  StoredState,
} from "../types";

export interface ResilientStoreOptions {
  /** Called on every error from the inner store */
  onError?: (error: unknown) => void;
  /**
   * "open" (default) = allow traffic when store is unavailable (fail-open).
   * "closed" = deny traffic (re-throw the error) when store is unavailable.
   */
  failMode?: "open" | "closed";
  /**
   * Number of consecutive failures before the circuit opens.
   * 0 = circuit breaker disabled (default).
   */
  threshold?: number;
  /** How long (ms) the circuit stays open before a half-open retry. Default 30s. */
  cooldownMs?: number;
}

/**
 * Wraps any RateLimitStore with:
 * - Configurable fail behavior (open = allow, closed = deny)
 * - Optional circuit breaker (skip calling broken store entirely)
 *
 * Backwards-compatible: `new ResilientStore(store, onError?)` still works.
 */
export class ResilientStore implements RateLimitStore {
  private readonly store: RateLimitStore;
  private readonly onError?: (error: unknown) => void;
  private readonly failMode: "open" | "closed";
  private readonly threshold: number;
  private readonly cooldownMs: number;

  private failures = 0;
  private circuitOpenUntil = 0;

  constructor(
    store: RateLimitStore,
    options?: ResilientStoreOptions | ((error: unknown) => void)
  ) {
    this.store = store;
    if (typeof options === "function") {
      this.onError = options;
      this.failMode = "open";
      this.threshold = 0;
      this.cooldownMs = 30_000;
    } else {
      this.onError = options?.onError;
      this.failMode = options?.failMode ?? "open";
      this.threshold = options?.threshold ?? 0;
      this.cooldownMs = options?.cooldownMs ?? 30_000;
    }
  }

  private isCircuitOpen(): boolean {
    if (this.threshold <= 0) return false;
    if (this.failures < this.threshold) return false;
    return Date.now() < this.circuitOpenUntil;
  }

  private recordFailure(error: unknown): void {
    this.onError?.(error);
    if (this.threshold > 0) {
      this.failures++;
      if (this.failures >= this.threshold) {
        this.circuitOpenUntil = Date.now() + this.cooldownMs;
      }
    }
  }

  private recordSuccess(): void {
    this.failures = 0;
  }

  async get(key: string): Promise<StoredState | null> {
    if (this.isCircuitOpen()) {
      if (this.failMode === "closed")
        throw new Error("Circuit open: store unavailable");
      return null;
    }
    try {
      const result = await this.store.get(key);
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error);
      if (this.failMode === "closed") throw error;
      return null;
    }
  }

  async set(key: string, state: StoredState, ttlMs: number): Promise<void> {
    if (this.isCircuitOpen()) {
      if (this.failMode === "closed")
        throw new Error("Circuit open: store unavailable");
      return;
    }
    try {
      await this.store.set(key, state, ttlMs);
      this.recordSuccess();
    } catch (error) {
      this.recordFailure(error);
      if (this.failMode === "closed") throw error;
    }
  }

  async check(
    key: string,
    config: AlgorithmConfig,
    nowMs: number,
    ttlMs: number
  ): Promise<RateLimitResult> {
    if (this.isCircuitOpen()) {
      if (this.failMode === "closed")
        throw new Error("Circuit open: store unavailable");
      // Fail-open: allow traffic
      return { allowed: true, limit: 0, remaining: 0, resetMs: 0, retryAfterMs: 0 };
    }
    try {
      const result = await this.store.check(key, config, nowMs, ttlMs);
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error);
      if (this.failMode === "closed") throw error;
      // Fail-open: allow traffic
      return { allowed: true, limit: 0, remaining: 0, resetMs: 0, retryAfterMs: 0 };
    }
  }
}
