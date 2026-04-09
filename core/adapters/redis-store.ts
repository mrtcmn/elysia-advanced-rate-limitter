import type { AlgorithmConfig, RateLimitResult, RateLimitStore, StoredState } from "../types";

/**
 * Minimal Redis client interface — compatible with ioredis, redis, etc.
 * Consumers inject their own client instance.
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    px: "PX",
    ttl: number
  ): Promise<string | null>;
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * GCRA (Generic Cell Rate Algorithm) — token bucket via single number.
 * No cjson.encode/decode, no JSON — just one number (TAT) stored as string.
 * Minimal Lua: GET a number, compare, SET a number.
 *
 * Returns: "allowed remaining resetMs retryAfterMs" (space-delimited)
 */
const LUA_GCRA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local emissionMs = tonumber(ARGV[2])
local burstMs = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
local ttlMs = tonumber(ARGV[5])

local tat = tonumber(redis.call('GET', key) or nowMs)
local newTat = math.max(tat, nowMs) + emissionMs
local allowAt = newTat - burstMs

if nowMs < allowAt then
  local retryAfterMs = math.ceil(allowAt - nowMs)
  local resetMs = math.max(0, math.ceil(tat - nowMs))
  return '0 0 ' .. resetMs .. ' ' .. retryAfterMs
end

redis.call('SET', key, tostring(newTat), 'PX', ttlMs)
local remaining = math.max(0, math.floor((burstMs - (newTat - nowMs)) / emissionMs))
local resetMs = math.max(0, math.ceil(newTat - nowMs))
return '1 ' .. remaining .. ' ' .. resetMs .. ' 0'
`;

export class RedisStore implements RateLimitStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly prefix: string = "rl:",
    private readonly timeoutMs: number = 0
  ) {}

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    if (this.timeoutMs <= 0) return promise;
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `Redis operation timed out after ${this.timeoutMs}ms`
              )
            ),
          this.timeoutMs
        )
      ),
    ]);
  }

  async get(key: string): Promise<StoredState | null> {
    const raw = await this.withTimeout(this.redis.get(this.prefix + key));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as StoredState;
  }

  async set(key: string, state: StoredState, ttlMs: number): Promise<void> {
    await this.withTimeout(
      this.redis.set(this.prefix + key, JSON.stringify(state), "PX", ttlMs)
    );
  }

  async check(
    key: string,
    config: AlgorithmConfig,
    nowMs: number,
    ttlMs: number
  ): Promise<RateLimitResult> {
    const fullKey = this.prefix + key;

    switch (config.algorithm) {
      case "fixed-window":
        return this.checkFixedWindow(fullKey, config.limit, config.windowMs, nowMs, ttlMs);
      case "sliding-window":
        return this.checkSlidingWindow(fullKey, config.limit, config.windowMs, nowMs, ttlMs);
      case "token-bucket":
        return this.checkTokenBucket(fullKey, config.capacity, config.refillRate, nowMs, ttlMs);
    }
  }

  /**
   * Fixed window: bare INCR on a window-keyed counter.
   * No Lua, no blocking — INCR is a single atomic Redis command.
   */
  private async checkFixedWindow(
    key: string,
    limit: number,
    windowMs: number,
    nowMs: number,
    ttlMs: number
  ): Promise<RateLimitResult> {
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const windowKey = `${key}:w:${windowStart}`;

    const count = await this.withTimeout(this.redis.incr(windowKey));

    if (count === 1) {
      // Fire-and-forget: set expiry on first increment
      this.redis.pexpire(windowKey, ttlMs);
    }

    const resetMs = windowStart + windowMs - nowMs;

    if (count > limit) {
      return { allowed: false, limit, remaining: 0, resetMs, retryAfterMs: resetMs };
    }

    return { allowed: true, limit, remaining: limit - count, resetMs, retryAfterMs: 0 };
  }

  /**
   * Sliding window: INCR current + GET previous in parallel.
   * No Lua, no blocking — two independent atomic commands pipelined.
   * INCR-first means denied requests still increment (slightly conservative),
   * but guarantees we never exceed the limit.
   */
  private async checkSlidingWindow(
    key: string,
    limit: number,
    windowMs: number,
    nowMs: number,
    ttlMs: number
  ): Promise<RateLimitResult> {
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const prevWindowStart = windowStart - windowMs;
    const currKey = `${key}:w:${windowStart}`;
    const prevKey = `${key}:w:${prevWindowStart}`;

    // Pipeline: INCR current + GET previous in one round trip
    const [currCount, prevRaw] = await this.withTimeout(
      Promise.all([
        this.redis.incr(currKey),
        this.redis.get(prevKey),
      ])
    );

    if (currCount === 1) {
      // Fire-and-forget: set expiry on first increment
      this.redis.pexpire(currKey, ttlMs);
    }

    const prevCount = prevRaw ? Number(prevRaw) : 0;
    const elapsed = nowMs - windowStart;
    const weight = 1 - elapsed / windowMs;
    const estimated = Math.floor(prevCount * weight + currCount);
    const resetMs = Math.max(0, windowStart + windowMs - nowMs);

    if (estimated > limit) {
      return { allowed: false, limit, remaining: 0, resetMs, retryAfterMs: resetMs };
    }

    const remaining = Math.max(0, limit - estimated);
    return { allowed: true, limit, remaining, resetMs, retryAfterMs: 0 };
  }

  /**
   * Token bucket via GCRA: minimal Lua — no cjson, stores one number.
   * Returns space-delimited "allowed remaining resetMs retryAfterMs".
   */
  private async checkTokenBucket(
    key: string,
    capacity: number,
    refillRate: number,
    nowMs: number,
    ttlMs: number
  ): Promise<RateLimitResult> {
    const emissionMs = 1000 / refillRate;
    const burstMs = emissionMs * capacity;

    const raw = await this.withTimeout(
      this.redis.eval(
        LUA_GCRA,
        1,
        key,
        String(capacity),
        String(emissionMs),
        String(burstMs),
        String(nowMs),
        String(ttlMs)
      )
    );

    const parts = (raw as string).split(" ");
    return {
      allowed: parts[0] === "1",
      limit: capacity,
      remaining: Number(parts[1]),
      resetMs: Number(parts[2]),
      retryAfterMs: Number(parts[3]),
    };
  }
}
