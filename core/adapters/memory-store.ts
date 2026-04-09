import { fixedWindow } from "../algorithms/fixed-window";
import { slidingWindow } from "../algorithms/sliding-window";
import { tokenBucket } from "../algorithms/token-bucket";
import type {
  AlgorithmConfig,
  AlgorithmFn,
  RateLimitResult,
  RateLimitStore,
  StoredState,
} from "../types";

const ALGORITHMS: Record<AlgorithmConfig["algorithm"], AlgorithmFn> = {
  "token-bucket": tokenBucket as AlgorithmFn,
  "sliding-window": slidingWindow as AlgorithmFn,
  "fixed-window": fixedWindow as AlgorithmFn,
};

interface Entry {
  state: StoredState;
  expiresAt: number;
}

export interface MemoryStoreOptions {
  cleanupIntervalMs?: number;
  maxKeys?: number;
}

export class MemoryStore implements RateLimitStore {
  private readonly map = new Map<string, Entry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxKeys: number;

  constructor(options: MemoryStoreOptions | number = {}) {
    const opts =
      typeof options === "number"
        ? { cleanupIntervalMs: options }
        : options;
    const cleanupIntervalMs = opts.cleanupIntervalMs ?? 60_000;
    this.maxKeys = opts.maxKeys ?? 0;

    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(() => this.evict(), cleanupIntervalMs);
      if (this.cleanupTimer && "unref" in this.cleanupTimer) {
        this.cleanupTimer.unref();
      }
    }
  }

  get(key: string): StoredState | null {
    const entry = this.map.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return entry.state;
  }

  set(key: string, state: StoredState, ttlMs: number): void {
    if (
      this.maxKeys > 0 &&
      !this.map.has(key) &&
      this.map.size >= this.maxKeys
    ) {
      this.evictOldest();
    }
    this.map.set(key, { state, expiresAt: Date.now() + ttlMs });
  }

  check(
    key: string,
    config: AlgorithmConfig,
    nowMs: number,
    ttlMs: number
  ): RateLimitResult {
    const current = this.get(key);
    const algorithmFn = ALGORITHMS[config.algorithm];
    const { state, result } = algorithmFn(config, current, nowMs);
    this.set(key, state, ttlMs);
    return result;
  }

  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  get size(): number {
    return this.map.size;
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now >= entry.expiresAt) {
        this.map.delete(key);
      }
    }
  }

  private evictOldest(): void {
    const firstKey = this.map.keys().next().value;
    if (firstKey !== undefined) {
      this.map.delete(firstKey);
    }
  }
}
