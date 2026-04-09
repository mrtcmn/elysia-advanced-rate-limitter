import { beforeEach, describe, expect, it } from "bun:test";
import type { RedisClient } from "../../../core/adapters/redis-store";
import { RedisStore } from "../../../core/adapters/redis-store";
import type { AlgorithmConfig } from "../../../core/types";

/**
 * In-memory mock that simulates Redis commands.
 * Supports GET, SET, INCR, PEXPIRE, and EVAL (for token-bucket Lua script).
 */
function createMockRedis(): RedisClient & {
  data: Map<string, { value: string; expiresAt: number }>;
  calls: { method: string; args: unknown[] }[];
} {
  const data = new Map<string, { value: string; expiresAt: number }>();
  const calls: { method: string; args: unknown[] }[] = [];

  function getEntry(key: string): string | null {
    const entry = data.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      data.delete(key);
      return null;
    }
    return entry.value;
  }

  function setEntry(key: string, value: string, ttlMs?: number): void {
    data.set(key, {
      value,
      expiresAt: ttlMs != null ? Date.now() + ttlMs : Date.now() + 86400000,
    });
  }

  // GCRA Lua interpreter (only algorithm that still uses EVAL)
  function evalGCRA(keys: string[], argv: string[]): string {
    const key = keys[0]!;
    const capacity = Number(argv[0]);
    const emissionMs = Number(argv[1]);
    const burstMs = Number(argv[2]);
    const nowMs = Number(argv[3]);
    const ttlMs = Number(argv[4]);

    const raw = getEntry(key);
    const tat = raw ? Number(raw) : nowMs;

    const newTat = Math.max(tat, nowMs) + emissionMs;
    const allowAt = newTat - burstMs;

    if (nowMs < allowAt) {
      const retryAfterMs = Math.ceil(allowAt - nowMs);
      const resetMs = Math.max(0, Math.ceil(tat - nowMs));
      return `0 0 ${resetMs} ${retryAfterMs}`;
    }

    setEntry(key, String(newTat), ttlMs);
    const remaining = Math.max(0, Math.floor((burstMs - (newTat - nowMs)) / emissionMs));
    const resetMs = Math.max(0, Math.ceil(newTat - nowMs));
    return `1 ${remaining} ${resetMs} 0`;
  }

  return {
    data,
    calls,
    async get(key: string) {
      calls.push({ method: "get", args: [key] });
      return getEntry(key);
    },
    async set(key: string, value: string, _px: "PX", ttl: number) {
      calls.push({ method: "set", args: [key, value, _px, ttl] });
      setEntry(key, value, ttl);
      return "OK";
    },
    async incr(key: string) {
      calls.push({ method: "incr", args: [key] });
      const raw = getEntry(key);
      const newVal = raw ? Number(raw) + 1 : 1;
      const entry = data.get(key);
      // Preserve existing TTL on INCR
      data.set(key, {
        value: String(newVal),
        expiresAt: entry?.expiresAt ?? Date.now() + 86400000,
      });
      return newVal;
    },
    async pexpire(key: string, ms: number) {
      calls.push({ method: "pexpire", args: [key, ms] });
      const entry = data.get(key);
      if (entry) {
        entry.expiresAt = Date.now() + ms;
        return 1;
      }
      return 0;
    },
    async eval(script: string, numkeys: number, ...args: string[]) {
      calls.push({ method: "eval", args: [script, numkeys, ...args] });
      const keys = args.slice(0, numkeys);
      const argv = args.slice(numkeys);
      return evalGCRA(keys, argv);
    },
  };
}

/** Mock redis that throws on every operation */
function createFailingRedis(error: Error): RedisClient {
  return {
    async get() { throw error; },
    async set() { throw error; },
    async incr() { throw error; },
    async pexpire() { throw error; },
    async eval() { throw error; },
  };
}

/** Mock redis that hangs (simulates timeout) */
function createHangingRedis(delayMs: number): RedisClient {
  return {
    get: () => new Promise((r) => setTimeout(() => r(null), delayMs)),
    set: () => new Promise((r) => setTimeout(() => r("OK"), delayMs)),
    incr: () => new Promise((r) => setTimeout(() => r(1), delayMs)),
    pexpire: () => new Promise((r) => setTimeout(() => r(1), delayMs)),
    eval: () => new Promise((r) => setTimeout(() => r(null), delayMs)),
  };
}

describe("RedisStore", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;
  let store: RedisStore;

  beforeEach(() => {
    mockRedis = createMockRedis();
    store = new RedisStore(mockRedis);
  });

  describe("get", () => {
    it("returns null for missing key", async () => {
      const result = await store.get("missing");
      expect(result).toBeNull();
    });

    it("returns parsed state", async () => {
      mockRedis.data.set("rl:k1", {
        value: JSON.stringify({ count: 5 }),
        expiresAt: Date.now() + 60_000,
      });
      const result = await store.get("k1");
      expect(result).toEqual({ count: 5 });
    });

    it("prefixes key with 'rl:'", async () => {
      await store.get("mykey");
      expect(mockRedis.calls[0]!.args[0]).toBe("rl:mykey");
    });
  });

  describe("set", () => {
    it("stores JSON-serialized state", async () => {
      await store.set("k1", { count: 3 }, 5000);
      const raw = mockRedis.data.get("rl:k1")!.value;
      expect(JSON.parse(raw)).toEqual({ count: 3 });
    });

    it("passes PX and TTL to redis", async () => {
      await store.set("k1", {}, 12345);
      const call = mockRedis.calls.find((c) => c.method === "set")!;
      expect(call.args[2]).toBe("PX");
      expect(call.args[3]).toBe(12345);
    });
  });

  describe("check", () => {
    const fixedWindowConfig: AlgorithmConfig = {
      algorithm: "fixed-window",
      limit: 10,
      windowMs: 60_000,
    };

    const tokenBucketConfig: AlgorithmConfig = {
      algorithm: "token-bucket",
      capacity: 5,
      refillRate: 1,
    };

    const slidingWindowConfig: AlgorithmConfig = {
      algorithm: "sliding-window",
      limit: 10,
      windowMs: 60_000,
    };

    it("allows first request (fixed-window)", async () => {
      const result = await store.check("k1", fixedWindowConfig, Date.now(), 60_000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
      expect(result.limit).toBe(10);
    });

    it("uses INCR for fixed-window (no eval)", async () => {
      await store.check("k1", fixedWindowConfig, Date.now(), 60_000);
      const incrCalls = mockRedis.calls.filter((c) => c.method === "incr");
      const evalCalls = mockRedis.calls.filter((c) => c.method === "eval");
      expect(incrCalls.length).toBe(1);
      expect(evalCalls.length).toBe(0);
    });

    it("denies after limit reached (fixed-window)", async () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        await store.check("k1", fixedWindowConfig, now, 60_000);
      }
      const result = await store.check("k1", fixedWindowConfig, now, 60_000);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("allows first request (token-bucket)", async () => {
      const result = await store.check("k1", tokenBucketConfig, Date.now(), 60_000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it("uses eval for token-bucket (needs Lua for refill math)", async () => {
      await store.check("k1", tokenBucketConfig, Date.now(), 60_000);
      const evalCalls = mockRedis.calls.filter((c) => c.method === "eval");
      expect(evalCalls.length).toBe(1);
    });

    it("denies after tokens exhausted (token-bucket)", async () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        await store.check("k1", tokenBucketConfig, now, 60_000);
      }
      const result = await store.check("k1", tokenBucketConfig, now, 60_000);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("allows first request (sliding-window)", async () => {
      const result = await store.check("k1", slidingWindowConfig, Date.now(), 60_000);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(10);
    });

    it("uses INCR for sliding-window (no eval)", async () => {
      await store.check("k1", slidingWindowConfig, Date.now(), 60_000);
      const incrCalls = mockRedis.calls.filter((c) => c.method === "incr");
      const evalCalls = mockRedis.calls.filter((c) => c.method === "eval");
      expect(incrCalls.length).toBe(1);
      expect(evalCalls.length).toBe(0);
    });

    it("denies after limit reached (sliding-window)", async () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        await store.check("k1", slidingWindowConfig, now, 60_000);
      }
      const result = await store.check("k1", slidingWindowConfig, now, 60_000);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("isolates different keys", async () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        await store.check("k1", fixedWindowConfig, now, 60_000);
      }
      const result = await store.check("k2", fixedWindowConfig, now, 60_000);
      expect(result.allowed).toBe(true);
    });
  });

  describe("custom prefix", () => {
    it("uses custom prefix for all operations", async () => {
      const customStore = new RedisStore(mockRedis, "custom:");
      await customStore.set("k1", { v: 1 }, 60_000);
      expect(mockRedis.data.has("custom:k1")).toBe(true);

      await customStore.get("k1");
      const getCall = mockRedis.calls.find(
        (c) => c.method === "get" && c.args[0] === "custom:k1"
      );
      expect(getCall).toBeTruthy();
    });
  });

  describe("Redis connection failure", () => {
    it("propagates error on get", async () => {
      const failStore = new RedisStore(
        createFailingRedis(new Error("ECONNREFUSED"))
      );
      expect(failStore.get("k1")).rejects.toThrow("ECONNREFUSED");
    });

    it("propagates error on set", async () => {
      const failStore = new RedisStore(
        createFailingRedis(new Error("ECONNREFUSED"))
      );
      expect(failStore.set("k1", {}, 1000)).rejects.toThrow("ECONNREFUSED");
    });

    it("propagates error on check", async () => {
      const failStore = new RedisStore(
        createFailingRedis(new Error("ECONNREFUSED"))
      );
      expect(
        failStore.check(
          "k1",
          { algorithm: "fixed-window", limit: 10, windowMs: 60_000 },
          Date.now(),
          60_000
        )
      ).rejects.toThrow("ECONNREFUSED");
    });
  });

  describe("Redis timeout simulation (no timeoutMs)", () => {
    it("get hangs when redis is slow", async () => {
      const hangStore = new RedisStore(createHangingRedis(5000));
      const raceResult = await Promise.race([
        hangStore.get("k1"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
      expect(raceResult).toBe("timeout");
    });

    it("set hangs when redis is slow", async () => {
      const hangStore = new RedisStore(createHangingRedis(5000));
      const raceResult = await Promise.race([
        hangStore.set("k1", {}, 1000),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
      expect(raceResult).toBe("timeout");
    });

    it("check hangs when redis is slow", async () => {
      const hangStore = new RedisStore(createHangingRedis(5000));
      const raceResult = await Promise.race([
        hangStore.check(
          "k1",
          { algorithm: "fixed-window", limit: 10, windowMs: 60_000 },
          Date.now(),
          60_000
        ),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
      expect(raceResult).toBe("timeout");
    });
  });

  describe("timeoutMs option", () => {
    it("rejects get after timeout", async () => {
      const timeoutStore = new RedisStore(
        createHangingRedis(5000),
        "rl:",
        50
      );
      await expect(timeoutStore.get("k1")).rejects.toThrow("timed out");
    });

    it("rejects set after timeout", async () => {
      const timeoutStore = new RedisStore(
        createHangingRedis(5000),
        "rl:",
        50
      );
      await expect(timeoutStore.set("k1", {}, 1000)).rejects.toThrow(
        "timed out"
      );
    });

    it("rejects check after timeout", async () => {
      const timeoutStore = new RedisStore(
        createHangingRedis(5000),
        "rl:",
        50
      );
      await expect(
        timeoutStore.check(
          "k1",
          { algorithm: "fixed-window", limit: 10, windowMs: 60_000 },
          Date.now(),
          60_000
        )
      ).rejects.toThrow("timed out");
    });

    it("does not timeout when Redis is fast", async () => {
      const timeoutStore = new RedisStore(mockRedis, "rl:", 5000);
      await timeoutStore.set("k1", { v: 1 }, 60_000);
      const result = await timeoutStore.get("k1");
      expect(result).toEqual({ v: 1 });
    });
  });

  describe("JSON parse error from corrupted data", () => {
    it("throws on corrupted JSON", async () => {
      mockRedis.data.set("rl:corrupt", {
        value: "not-valid-json{{{",
        expiresAt: Date.now() + 60_000,
      });
      expect(store.get("corrupt")).rejects.toThrow();
    });
  });
});
