import { Elysia } from "elysia";
import { MemoryStore } from "../core/adapters/memory-store";
import type {
  AlgorithmConfig,
  RateLimiterOptions,
  RateLimitResult,
} from "../core/types";
import { ipResolver } from "../resolvers/ip-resolver";

// Maximum finite millisecond value used to replace Infinity in JSON-serializable fields.
const MAX_RETRY_MS = 2_147_483_647;

function sanitizeResult(result: RateLimitResult): RateLimitResult {
  return {
    ...result,
    retryAfterMs: Number.isFinite(result.retryAfterMs)
      ? result.retryAfterMs
      : MAX_RETRY_MS,
    resetMs: Number.isFinite(result.resetMs) ? result.resetMs : MAX_RETRY_MS,
  };
}

const DEFAULT_CONFIG: Required<
  Pick<RateLimiterOptions, "algorithm" | "errorResponse" | "prefix">
> = {
  algorithm: { algorithm: "token-bucket", capacity: 100, refillRate: 10 },
  errorResponse: (result: RateLimitResult) => ({
    error: "rate_limited",
    retryAfter: result.retryAfterMs,
  }),
  prefix: "rl:",
};

function validateAlgorithmConfig(config: AlgorithmConfig): void {
  switch (config.algorithm) {
    case "token-bucket":
      if (!Number.isFinite(config.capacity) || config.capacity <= 0) {
        throw new Error(`rate-limiter: token-bucket capacity must be a positive number, got ${config.capacity}`);
      }
      if (!Number.isFinite(config.refillRate) || config.refillRate <= 0) {
        throw new Error(`rate-limiter: token-bucket refillRate must be a positive number, got ${config.refillRate}`);
      }
      break;
    case "fixed-window":
    case "sliding-window":
      if (!Number.isFinite(config.limit) || config.limit <= 0 || !Number.isInteger(config.limit)) {
        throw new Error(`rate-limiter: ${config.algorithm} limit must be a positive integer, got ${config.limit}`);
      }
      if (!Number.isFinite(config.windowMs) || config.windowMs <= 0) {
        throw new Error(`rate-limiter: ${config.algorithm} windowMs must be a positive number, got ${config.windowMs}`);
      }
      break;
  }
}

function computeTtlMs(config: AlgorithmConfig): number {
  switch (config.algorithm) {
    case "token-bucket":
      return Math.ceil((config.capacity / config.refillRate) * 1000) + 60_000;
    case "sliding-window":
      return config.windowMs + 60_000;
    case "fixed-window":
      return config.windowMs + 60_000;
  }
}

// biome-ignore lint/suspicious/noExplicitAny: Elysia plugin return type is complex and version-dependent
export function rateLimiter(options: RateLimiterOptions = {}): any {
  const algorithmConfig = options.algorithm ?? DEFAULT_CONFIG.algorithm;
  validateAlgorithmConfig(algorithmConfig);
  const store = options.store ?? new MemoryStore({ maxKeys: 100_000 });
  const keyResolve = options.keyResolver ?? ipResolver();
  const errorResponse = options.errorResponse ?? DEFAULT_CONFIG.errorResponse;
  const skip = options.skip;
  const prefix = options.prefix ?? DEFAULT_CONFIG.prefix;
  const ttlMs = computeTtlMs(algorithmConfig);

  const resultMap = new WeakMap<Request, RateLimitResult>();

  return new Elysia({ name: `rate-limiter-${prefix}` })
    .onRequest(async ({ request, set }) => {
      if (skip?.(request)) {
        return undefined;
      }

      const key = keyResolve(request);
      if (key === null) {
        return undefined;
      }

      const storeKey = `${prefix}${key}`;
      const nowMs = Date.now();

      const rawResult = await store.check(storeKey, algorithmConfig, nowMs, ttlMs);
      const result = sanitizeResult(rawResult);
      resultMap.set(request, result);

      if (!result.allowed) {
        const body = JSON.stringify(errorResponse(result));
        const retryAfter = String(Math.ceil(result.retryAfterMs / 1000));
        const limit = String(result.limit);
        const reset = String(Math.ceil((Date.now() + result.resetMs) / 1000));

        set.status = 429;
        set.headers["Retry-After"] = retryAfter;
        set.headers["X-RateLimit-Limit"] = limit;
        set.headers["X-RateLimit-Remaining"] = "0";
        set.headers["X-RateLimit-Reset"] = reset;

        return new globalThis.Response(body, {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": retryAfter,
            "X-RateLimit-Limit": limit,
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": reset,
          },
        });
      }

      return undefined;
    })
    .onAfterHandle({ as: "global" }, ({ request, set }) => {
      const result = resultMap.get(request);
      if (!result) {
        return;
      }

      set.headers["X-RateLimit-Limit"] = String(result.limit);
      set.headers["X-RateLimit-Remaining"] = String(result.remaining);
      set.headers["X-RateLimit-Reset"] = String(
        Math.ceil((Date.now() + result.resetMs) / 1000)
      );
    });
}
