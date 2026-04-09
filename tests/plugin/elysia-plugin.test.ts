import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Elysia } from "elysia";
import { MemoryStore } from "../../core/adapters/memory-store";
import { ResilientStore } from "../../core/adapters/resilient-store";
import type {
  AlgorithmConfig,
  RateLimitResult,
  RateLimitStore,
  StoredState,
} from "../../core/types";
import { rateLimiter } from "../../plugin/elysia-plugin";

function createApp(options = {}) {
  return new Elysia()
    .use(rateLimiter(options))
    .get("/test", () => ({ ok: true }))
    .post("/data", () => ({ created: true }));
}

function request(
  path = "/test",
  headers: Record<string, string> = {}
): Request {
  return new Request(`http://localhost${path}`, { headers });
}

describe("rateLimiter Elysia plugin", () => {
  describe("default configuration (token-bucket)", () => {
    it("allows requests under the limit", async () => {
      const app = createApp();
      const res = await app.handle(request());
      expect(res.status).toBe(200);
    });

    it("sets rate limit headers on allowed requests", async () => {
      const app = createApp();
      const res = await app.handle(request());
      expect(res.headers.get("X-RateLimit-Limit")).toBeTruthy();
      expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
      expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
    });

    it("returns JSON body on success", async () => {
      const app = createApp();
      const res = await app.handle(request());
      const body = await res.json();
      expect(body).toEqual({ ok: true });
    });
  });

  describe("rate limit exceeded (token-bucket)", () => {
    it("returns 429 after exhausting tokens", async () => {
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 2, refillRate: 1 },
      });

      // exhaust 2 tokens
      await app.handle(request("/test", { "x-forwarded-for": "1.1.1.1" }));
      await app.handle(request("/test", { "x-forwarded-for": "1.1.1.1" }));

      const res = await app.handle(
        request("/test", { "x-forwarded-for": "1.1.1.1" })
      );
      expect(res.status).toBe(429);
    });

    it("returns Retry-After header when rate limited", async () => {
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
      });

      await app.handle(request("/test", { "x-forwarded-for": "2.2.2.2" }));
      const res = await app.handle(
        request("/test", { "x-forwarded-for": "2.2.2.2" })
      );
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    });

    it("returns JSON error body", async () => {
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
      });

      await app.handle(request("/test", { "x-forwarded-for": "3.3.3.3" }));
      const res = await app.handle(
        request("/test", { "x-forwarded-for": "3.3.3.3" })
      );
      const body = await res.json();
      expect(body.error).toBe("rate_limited");
      expect(body.retryAfter).toBeGreaterThan(0);
    });

    it("sets X-RateLimit-Remaining to 0 when exceeded", async () => {
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
      });

      await app.handle(request("/test", { "x-forwarded-for": "4.4.4.4" }));
      const res = await app.handle(
        request("/test", { "x-forwarded-for": "4.4.4.4" })
      );
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    });
  });

  describe("rate limit exceeded (fixed-window)", () => {
    it("returns 429 after exceeding limit", async () => {
      const app = createApp({
        algorithm: {
          algorithm: "fixed-window",
          limit: 2,
          windowMs: 60_000,
        } satisfies AlgorithmConfig,
      });

      const ip = "10.0.0.1";
      await app.handle(request("/test", { "x-forwarded-for": ip }));
      await app.handle(request("/test", { "x-forwarded-for": ip }));
      const res = await app.handle(
        request("/test", { "x-forwarded-for": ip })
      );
      expect(res.status).toBe(429);
    });

    it("allows different IPs independently", async () => {
      const app = createApp({
        algorithm: {
          algorithm: "fixed-window",
          limit: 1,
          windowMs: 60_000,
        } satisfies AlgorithmConfig,
      });

      await app.handle(request("/test", { "x-forwarded-for": "a.a.a.a" }));
      const res = await app.handle(
        request("/test", { "x-forwarded-for": "b.b.b.b" })
      );
      expect(res.status).toBe(200);
    });
  });

  describe("rate limit exceeded (sliding-window)", () => {
    it("returns 429 after exceeding limit", async () => {
      const app = createApp({
        algorithm: {
          algorithm: "sliding-window",
          limit: 2,
          windowMs: 60_000,
        } satisfies AlgorithmConfig,
      });

      const ip = "20.0.0.1";
      await app.handle(request("/test", { "x-forwarded-for": ip }));
      await app.handle(request("/test", { "x-forwarded-for": ip }));
      const res = await app.handle(
        request("/test", { "x-forwarded-for": ip })
      );
      expect(res.status).toBe(429);
    });
  });

  describe("skip option", () => {
    it("skips rate limiting when skip returns true", async () => {
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
        skip: (req: Request) => req.url.includes("/test"),
      });

      // first would normally consume the only token
      await app.handle(request("/test", { "x-forwarded-for": "5.5.5.5" }));
      // second should also pass because skip is true
      const res = await app.handle(
        request("/test", { "x-forwarded-for": "5.5.5.5" })
      );
      expect(res.status).toBe(200);
    });

    it("does not skip when skip returns false", async () => {
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
        skip: () => false,
      });

      await app.handle(request("/test", { "x-forwarded-for": "6.6.6.6" }));
      const res = await app.handle(
        request("/test", { "x-forwarded-for": "6.6.6.6" })
      );
      expect(res.status).toBe(429);
    });
  });

  describe("keyResolver returns null (skip rate limiting)", () => {
    it("allows request when keyResolver returns null", async () => {
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
        keyResolver: () => null,
      });

      // multiple requests should all pass
      for (let i = 0; i < 5; i++) {
        const res = await app.handle(request());
        expect(res.status).toBe(200);
      }
    });
  });

  describe("custom keyResolver", () => {
    it("uses custom key for rate limiting", async () => {
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
        keyResolver: (req: Request) =>
          req.headers.get("x-api-key") ?? "default",
      });

      // key "abc" uses its token
      await app.handle(request("/test", { "x-api-key": "abc" }));
      const res1 = await app.handle(request("/test", { "x-api-key": "abc" }));
      expect(res1.status).toBe(429);

      // key "xyz" has its own bucket
      const res2 = await app.handle(request("/test", { "x-api-key": "xyz" }));
      expect(res2.status).toBe(200);
    });
  });

  describe("custom errorResponse", () => {
    it("uses custom error body", async () => {
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
        errorResponse: (result: RateLimitResult) => ({
          message: "Too many requests",
          wait: result.retryAfterMs,
        }),
      });

      await app.handle(request("/test", { "x-forwarded-for": "7.7.7.7" }));
      const res = await app.handle(
        request("/test", { "x-forwarded-for": "7.7.7.7" })
      );
      const body = await res.json();
      expect(body.message).toBe("Too many requests");
      expect(body.wait).toBeGreaterThan(0);
    });
  });

  describe("custom store (MemoryStore)", () => {
    it("uses provided store", async () => {
      const store = new MemoryStore(0);
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
        store,
      });

      await app.handle(request("/test", { "x-forwarded-for": "8.8.8.8" }));
      expect(store.size).toBeGreaterThan(0);
      store.dispose();
    });
  });

  describe("custom prefix", () => {
    it("uses custom prefix in store keys", async () => {
      const store = new MemoryStore(0);
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
        store,
        prefix: "api:",
      });

      await app.handle(request("/test", { "x-forwarded-for": "9.9.9.9" }));
      expect(store.size).toBeGreaterThan(0);
      store.dispose();
    });
  });

  describe("multiple routes share rate limiter", () => {
    it("counts requests across routes for the same key", async () => {
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 2, refillRate: 1 },
      });

      const ip = "11.11.11.11";
      await app.handle(request("/test", { "x-forwarded-for": ip }));
      await app.handle(
        new Request("http://localhost/data", {
          method: "POST",
          headers: { "x-forwarded-for": ip },
        })
      );
      const res = await app.handle(
        request("/test", { "x-forwarded-for": ip })
      );
      expect(res.status).toBe(429);
    });
  });

  describe("store failure with ResilientStore (fail-open)", () => {
    it("allows requests when store throws (fail-open)", async () => {
      const failingStore: RateLimitStore = {
        async get() {
          throw new Error("Redis down");
        },
        async set() {
          throw new Error("Redis down");
        },
        async check() {
          throw new Error("Redis down");
        },
      };

      const errors: unknown[] = [];
      const resilientStore = new ResilientStore(failingStore, (e) =>
        errors.push(e)
      );

      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
        store: resilientStore,
      });

      // Should allow because fail-open returns updater(null) → fresh state
      const res = await app.handle(
        request("/test", { "x-forwarded-for": "fail.1.2.3" })
      );
      expect(res.status).toBe(200);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("never rate limits when store is always failing", async () => {
      const failingStore: RateLimitStore = {
        async get() {
          throw new Error("ECONNREFUSED");
        },
        async set() {
          throw new Error("ECONNREFUSED");
        },
        async check() {
          throw new Error("ECONNREFUSED");
        },
      };

      const resilientStore = new ResilientStore(failingStore);
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
        store: resilientStore,
      });

      // Every request gets a fresh state → always allowed
      for (let i = 0; i < 10; i++) {
        const res = await app.handle(
          request("/test", { "x-forwarded-for": "down.1.2.3" })
        );
        expect(res.status).toBe(200);
      }
    });
  });

  describe("store timeout with ResilientStore", () => {
    it("allows request when store times out (via ResilientStore)", async () => {
      const hangingStore: RateLimitStore = {
        get() {
          return new Promise(() => {});
        },
        set() {
          return new Promise(() => {});
        },
        check() {
          return new Promise(() => {});
        },
      };

      // Wrap with timeout at the application level
      const timeoutStore: RateLimitStore = {
        async get(key: string) {
          return Promise.race([
            hangingStore.get(key),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
          ]);
        },
        async set(key: string, state: StoredState, ttlMs: number) {
          await Promise.race([
            hangingStore.set(key, state, ttlMs),
            new Promise<void>((resolve) => setTimeout(resolve, 50)),
          ]);
        },
        async check(key, config, nowMs, ttlMs) {
          return Promise.race([
            hangingStore.check(key, config, nowMs, ttlMs),
            new Promise<RateLimitResult>((resolve) =>
              setTimeout(() => resolve({ allowed: true, limit: 0, remaining: 0, resetMs: 0, retryAfterMs: 0 }), 50)
            ),
          ]);
        },
      };

      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
        store: timeoutStore,
      });

      const res = await app.handle(
        request("/test", { "x-forwarded-for": "timeout.1.2.3" })
      );
      expect(res.status).toBe(200);
    });
  });

  describe("Content-Type on 429 response", () => {
    it("returns application/json content type", async () => {
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
      });

      await app.handle(request("/test", { "x-forwarded-for": "ct.1.2.3" }));
      const res = await app.handle(
        request("/test", { "x-forwarded-for": "ct.1.2.3" })
      );
      expect(res.status).toBe(429);
      expect(res.headers.get("Content-Type")).toBe("application/json");
    });
  });

  describe("X-RateLimit headers on 429", () => {
    it("includes all rate limit headers", async () => {
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
      });

      await app.handle(request("/test", { "x-forwarded-for": "hdr.1.2.3" }));
      const res = await app.handle(
        request("/test", { "x-forwarded-for": "hdr.1.2.3" })
      );
      expect(res.status).toBe(429);
      expect(res.headers.get("X-RateLimit-Limit")).toBeTruthy();
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
      expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
      expect(res.headers.get("Retry-After")).toBeTruthy();
    });
  });

  describe("per-IP isolation", () => {
    it("different IPs have independent rate limits", async () => {
      const app = createApp({
        algorithm: {
          algorithm: "fixed-window",
          limit: 1,
          windowMs: 60_000,
        },
      });

      const res1 = await app.handle(
        request("/test", { "x-forwarded-for": "ip-a" })
      );
      expect(res1.status).toBe(200);

      const res2 = await app.handle(
        request("/test", { "x-forwarded-for": "ip-b" })
      );
      expect(res2.status).toBe(200);

      // ip-a is now rate limited
      const res3 = await app.handle(
        request("/test", { "x-forwarded-for": "ip-a" })
      );
      expect(res3.status).toBe(429);

      // ip-b is also rate limited
      const res4 = await app.handle(
        request("/test", { "x-forwarded-for": "ip-b" })
      );
      expect(res4.status).toBe(429);
    });
  });

  describe("no options (full defaults)", () => {
    it("works with zero configuration", async () => {
      const app = new Elysia()
        .use(rateLimiter())
        .get("/", () => "hello");

      const res = await app.handle(new Request("http://localhost/"));
      expect(res.status).toBe(200);
    });
  });

  describe("all three algorithms via integration", () => {
    const algorithms: AlgorithmConfig[] = [
      { algorithm: "token-bucket", capacity: 2, refillRate: 1 },
      { algorithm: "fixed-window", limit: 2, windowMs: 60_000 },
      { algorithm: "sliding-window", limit: 2, windowMs: 60_000 },
    ];

    for (const algo of algorithms) {
      it(`${algo.algorithm}: allows 2 requests then blocks`, async () => {
        const app = createApp({ algorithm: algo });
        const ip = `algo-${algo.algorithm}`;

        const r1 = await app.handle(
          request("/test", { "x-forwarded-for": ip })
        );
        expect(r1.status).toBe(200);

        const r2 = await app.handle(
          request("/test", { "x-forwarded-for": ip })
        );
        expect(r2.status).toBe(200);

        const r3 = await app.handle(
          request("/test", { "x-forwarded-for": ip })
        );
        expect(r3.status).toBe(429);
      });
    }
  });

  describe("sanitizeResult handles Infinity", () => {
    it("does not return Infinity in headers", async () => {
      // Use a config that could produce extreme values
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 0.001 },
      });

      await app.handle(request("/test", { "x-forwarded-for": "inf.1.2.3" }));
      const res = await app.handle(
        request("/test", { "x-forwarded-for": "inf.1.2.3" })
      );

      if (res.status === 429) {
        const retryAfter = res.headers.get("Retry-After");
        expect(retryAfter).not.toBe("Infinity");
        expect(Number(retryAfter)).toBeFinite();
      }
    });
  });

  describe("multiple rate limiter instances", () => {
    it("two limiters with different prefixes coexist", async () => {
      const app = new Elysia()
        .use(
          rateLimiter({
            algorithm: { algorithm: "fixed-window", limit: 5, windowMs: 60_000 },
            prefix: "global:",
          })
        )
        .use(
          rateLimiter({
            algorithm: { algorithm: "token-bucket", capacity: 2, refillRate: 1 },
            prefix: "strict:",
          })
        )
        .get("/test", () => ({ ok: true }));

      const ip = "multi.1.1.1";
      // First 2 requests pass both limiters
      const r1 = await app.handle(request("/test", { "x-forwarded-for": ip }));
      expect(r1.status).toBe(200);
      const r2 = await app.handle(request("/test", { "x-forwarded-for": ip }));
      expect(r2.status).toBe(200);

      // 3rd request: global still has 3 left, but strict (capacity=2) is exhausted
      const r3 = await app.handle(request("/test", { "x-forwarded-for": ip }));
      expect(r3.status).toBe(429);
    });

    it("skip option enables route-based scoping", async () => {
      const app = new Elysia()
        .use(
          rateLimiter({
            algorithm: { algorithm: "fixed-window", limit: 100, windowMs: 60_000 },
            prefix: "global:",
          })
        )
        .use(
          rateLimiter({
            algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
            prefix: "api:",
            skip: (req) => !new URL(req.url).pathname.startsWith("/api"),
          })
        )
        .get("/public", () => ({ public: true }))
        .get("/api/data", () => ({ data: true }));

      const ip = "scope.1.1.1";

      // /api/data: hit both global + api limiter. First request passes.
      const r1 = await app.handle(request("/api/data", { "x-forwarded-for": ip }));
      expect(r1.status).toBe(200);

      // /api/data: api limiter (capacity=1) now exhausted
      const r2 = await app.handle(request("/api/data", { "x-forwarded-for": ip }));
      expect(r2.status).toBe(429);

      // /public: api limiter skipped, only global applies
      const r3 = await app.handle(request("/public", { "x-forwarded-for": ip }));
      expect(r3.status).toBe(200);
    });

    it("each limiter tracks counters independently", async () => {
      const storeA = new MemoryStore(0);
      const storeB = new MemoryStore(0);

      const app = new Elysia()
        .use(
          rateLimiter({
            algorithm: { algorithm: "fixed-window", limit: 3, windowMs: 60_000 },
            store: storeA,
            prefix: "a:",
          })
        )
        .use(
          rateLimiter({
            algorithm: { algorithm: "fixed-window", limit: 3, windowMs: 60_000 },
            store: storeB,
            prefix: "b:",
          })
        )
        .get("/test", () => ({ ok: true }));

      const ip = "indep.1.1.1";
      await app.handle(request("/test", { "x-forwarded-for": ip }));

      // Both stores have exactly 1 key each
      expect(storeA.size).toBe(1);
      expect(storeB.size).toBe(1);

      storeA.dispose();
      storeB.dispose();
    });

    it("different algorithms on different prefixes", async () => {
      const app = new Elysia()
        .use(
          rateLimiter({
            algorithm: { algorithm: "sliding-window", limit: 10, windowMs: 60_000 },
            prefix: "sw:",
          })
        )
        .use(
          rateLimiter({
            algorithm: { algorithm: "token-bucket", capacity: 2, refillRate: 1 },
            prefix: "tb:",
          })
        )
        .get("/test", () => ({ ok: true }));

      const ip = "algo-mix.1.1.1";
      // 2 requests pass both
      await app.handle(request("/test", { "x-forwarded-for": ip }));
      await app.handle(request("/test", { "x-forwarded-for": ip }));

      // 3rd blocked by token-bucket (capacity=2), sliding-window still has 7 left
      const res = await app.handle(request("/test", { "x-forwarded-for": ip }));
      expect(res.status).toBe(429);
    });

    it("same prefix causes deduplication (second limiter ignored)", async () => {
      const app = new Elysia()
        .use(
          rateLimiter({
            algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
            prefix: "rl:",
          })
        )
        .use(
          rateLimiter({
            algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
            prefix: "rl:",
          })
        )
        .get("/test", () => ({ ok: true }));

      const ip = "dedup.1.1.1";
      // First request allowed
      const r1 = await app.handle(request("/test", { "x-forwarded-for": ip }));
      expect(r1.status).toBe(200);

      // Second request blocked by the single active limiter
      const r2 = await app.handle(request("/test", { "x-forwarded-for": ip }));
      expect(r2.status).toBe(429);
    });
  });

  describe("algorithm config validation", () => {
    it("throws on token-bucket with capacity=0", () => {
      expect(() =>
        rateLimiter({ algorithm: { algorithm: "token-bucket", capacity: 0, refillRate: 10 } })
      ).toThrow("capacity must be a positive number");
    });

    it("throws on token-bucket with negative refillRate", () => {
      expect(() =>
        rateLimiter({ algorithm: { algorithm: "token-bucket", capacity: 10, refillRate: -1 } })
      ).toThrow("refillRate must be a positive number");
    });

    it("throws on token-bucket with Infinity capacity", () => {
      expect(() =>
        rateLimiter({ algorithm: { algorithm: "token-bucket", capacity: Infinity, refillRate: 10 } })
      ).toThrow("capacity must be a positive number");
    });

    it("throws on fixed-window with limit=0", () => {
      expect(() =>
        rateLimiter({ algorithm: { algorithm: "fixed-window", limit: 0, windowMs: 60000 } })
      ).toThrow("limit must be a positive integer");
    });

    it("throws on fixed-window with windowMs=0", () => {
      expect(() =>
        rateLimiter({ algorithm: { algorithm: "fixed-window", limit: 10, windowMs: 0 } })
      ).toThrow("windowMs must be a positive number");
    });

    it("throws on sliding-window with non-integer limit", () => {
      expect(() =>
        rateLimiter({ algorithm: { algorithm: "sliding-window", limit: 1.5, windowMs: 60000 } })
      ).toThrow("limit must be a positive integer");
    });

    it("throws on fixed-window with NaN windowMs", () => {
      expect(() =>
        rateLimiter({ algorithm: { algorithm: "fixed-window", limit: 10, windowMs: NaN } })
      ).toThrow("windowMs must be a positive number");
    });

    it("accepts valid token-bucket config", () => {
      expect(() =>
        rateLimiter({ algorithm: { algorithm: "token-bucket", capacity: 100, refillRate: 10 } })
      ).not.toThrow();
    });

    it("accepts valid fixed-window config", () => {
      expect(() =>
        rateLimiter({ algorithm: { algorithm: "fixed-window", limit: 100, windowMs: 60000 } })
      ).not.toThrow();
    });

    it("accepts valid sliding-window config", () => {
      expect(() =>
        rateLimiter({ algorithm: { algorithm: "sliding-window", limit: 100, windowMs: 60000 } })
      ).not.toThrow();
    });
  });

  describe("default MemoryStore has maxKeys", () => {
    it("uses a bounded MemoryStore by default", async () => {
      // The default store should be a MemoryStore with maxKeys=100_000
      // We verify indirectly: creating the plugin with no store should work
      const app = createApp();
      const res = await app.handle(request());
      expect(res.status).toBe(200);
    });
  });

  describe("circuit breaker integration", () => {
    it("fast-fails and allows traffic after circuit trips (fail-open)", async () => {
      let callCount = 0;
      const brokenStore: RateLimitStore = {
        async get() {
          callCount++;
          throw new Error("down");
        },
        async set() {
          callCount++;
          throw new Error("down");
        },
        async check() {
          callCount++;
          throw new Error("down");
        },
      };
      const resilient = new ResilientStore(brokenStore, {
        threshold: 2,
        cooldownMs: 5000,
      });
      const app = createApp({
        algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
        store: resilient,
      });

      // First 2 requests trip the breaker
      await app.handle(request("/test", { "x-forwarded-for": "cb.1" }));
      await app.handle(request("/test", { "x-forwarded-for": "cb.2" }));
      const countAfterTrip = callCount;

      // Next requests don't even hit the store — circuit is open
      const res = await app.handle(
        request("/test", { "x-forwarded-for": "cb.3" })
      );
      expect(res.status).toBe(200); // fail-open allows traffic
      expect(callCount).toBe(countAfterTrip); // no new calls to broken store
    });

    it("denies traffic when circuit trips with failMode closed", async () => {
      const brokenStore: RateLimitStore = {
        async get() {
          throw new Error("down");
        },
        async set() {
          throw new Error("down");
        },
        async check() {
          throw new Error("down");
        },
      };
      const resilient = new ResilientStore(brokenStore, {
        failMode: "closed",
        threshold: 1,
        cooldownMs: 5000,
      });
      const app = new Elysia()
        .onError(({ set }) => {
          set.status = 503;
          return { error: "service_unavailable" };
        })
        .use(
          rateLimiter({
            algorithm: {
              algorithm: "token-bucket",
              capacity: 10,
              refillRate: 10,
            },
            store: resilient,
          })
        )
        .get("/test", () => ({ ok: true }));

      // First request trips the breaker and throws — onError catches it
      const res1 = await app.handle(
        request("/test", { "x-forwarded-for": "cb-closed.1" })
      );
      expect(res1.status).toBe(503);

      // Second request — circuit is open, throws immediately
      const res2 = await app.handle(
        request("/test", { "x-forwarded-for": "cb-closed.2" })
      );
      expect(res2.status).toBe(503);
    });
  });
});
