import { beforeEach, describe, expect, it } from "bun:test";
import type { AlgorithmConfig, RateLimitResult, RateLimitStore, StoredState } from "../../../core/types";
import { ResilientStore } from "../../../core/adapters/resilient-store";

const fixedWindowConfig: AlgorithmConfig = {
  algorithm: "fixed-window",
  limit: 10,
  windowMs: 60_000,
};

/** Store that works normally */
function createWorkingStore(): RateLimitStore & {
  data: Map<string, StoredState>;
} {
  const data = new Map<string, StoredState>();
  return {
    data,
    get(key: string) {
      return data.get(key) ?? null;
    },
    set(key: string, state: StoredState) {
      data.set(key, state);
    },
    check(
      _key: string,
      _config: AlgorithmConfig,
      _nowMs: number,
      _ttlMs: number
    ): RateLimitResult {
      return { allowed: true, limit: 10, remaining: 9, resetMs: 60_000, retryAfterMs: 0 };
    },
  };
}

/** Store that throws on every operation */
function createFailingStore(error: Error): RateLimitStore {
  return {
    get() {
      throw error;
    },
    set() {
      throw error;
    },
    check() {
      throw error;
    },
  };
}

/** Store that rejects with async errors */
function createAsyncFailingStore(error: Error): RateLimitStore {
  return {
    async get() {
      throw error;
    },
    async set() {
      throw error;
    },
    async check() {
      throw error;
    },
  };
}

/** Store where only get fails */
function createPartialFailStore(): RateLimitStore {
  const data = new Map<string, StoredState>();
  return {
    get() {
      throw new Error("get failed");
    },
    set(key: string, state: StoredState) {
      data.set(key, state);
    },
    check(): RateLimitResult {
      return { allowed: true, limit: 10, remaining: 9, resetMs: 60_000, retryAfterMs: 0 };
    },
  };
}

describe("ResilientStore", () => {
  describe("pass-through when inner store works", () => {
    let inner: ReturnType<typeof createWorkingStore>;
    let store: ResilientStore;

    beforeEach(() => {
      inner = createWorkingStore();
      store = new ResilientStore(inner);
    });

    it("get returns stored data", async () => {
      inner.data.set("k1", { count: 5 });
      const result = await store.get("k1");
      expect(result).toEqual({ count: 5 });
    });

    it("get returns null for missing key", async () => {
      const result = await store.get("missing");
      expect(result).toBeNull();
    });

    it("set stores data in inner store", async () => {
      await store.set("k1", { v: 1 }, 60_000);
      expect(inner.data.get("k1")).toEqual({ v: 1 });
    });

    it("check delegates to inner store", async () => {
      const result = await store.check("k1", fixedWindowConfig, Date.now(), 60_000);
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(10);
    });
  });

  describe("fail-open on synchronous errors", () => {
    const error = new Error("ECONNREFUSED");

    it("get returns null on error", async () => {
      const store = new ResilientStore(createFailingStore(error));
      const result = await store.get("k1");
      expect(result).toBeNull();
    });

    it("set is a no-op on error (does not throw)", async () => {
      const store = new ResilientStore(createFailingStore(error));
      await store.set("k1", { v: 1 }, 60_000);
    });

    it("check returns allowed on error (fail-open)", async () => {
      const store = new ResilientStore(createFailingStore(error));
      const result = await store.check("k1", fixedWindowConfig, Date.now(), 60_000);
      expect(result.allowed).toBe(true);
    });
  });

  describe("fail-open on async errors", () => {
    const error = new Error("Connection timeout");

    it("get returns null on async rejection", async () => {
      const store = new ResilientStore(createAsyncFailingStore(error));
      const result = await store.get("k1");
      expect(result).toBeNull();
    });

    it("set swallows async rejection", async () => {
      const store = new ResilientStore(createAsyncFailingStore(error));
      await store.set("k1", {}, 1000);
    });

    it("check returns allowed on async rejection (fail-open)", async () => {
      const store = new ResilientStore(createAsyncFailingStore(error));
      const result = await store.check("k1", fixedWindowConfig, Date.now(), 60_000);
      expect(result.allowed).toBe(true);
    });
  });

  describe("onError callback", () => {
    it("calls onError when get fails", async () => {
      const errors: unknown[] = [];
      const err = new Error("get boom");
      const store = new ResilientStore(createFailingStore(err), (e) =>
        errors.push(e)
      );
      await store.get("k1");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(err);
    });

    it("calls onError when set fails", async () => {
      const errors: unknown[] = [];
      const err = new Error("set boom");
      const store = new ResilientStore(createFailingStore(err), (e) =>
        errors.push(e)
      );
      await store.set("k1", {}, 1000);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(err);
    });

    it("calls onError when check fails", async () => {
      const errors: unknown[] = [];
      const err = new Error("check boom");
      const store = new ResilientStore(createFailingStore(err), (e) =>
        errors.push(e)
      );
      await store.check("k1", fixedWindowConfig, Date.now(), 60_000);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(err);
    });

    it("works without onError callback", async () => {
      const store = new ResilientStore(
        createFailingStore(new Error("no callback"))
      );
      await store.get("k1");
      await store.set("k1", {}, 1000);
      await store.check("k1", fixedWindowConfig, Date.now(), 60_000);
    });
  });

  describe("partial failure scenarios", () => {
    it("handles get failing but set working", async () => {
      const store = new ResilientStore(createPartialFailStore());
      const result = await store.get("k1");
      expect(result).toBeNull();
      await store.set("k1", { v: 1 }, 60_000);
    });
  });

  describe("Redis connection broken mid-operation", () => {
    it("recovers gracefully when inner store throws after initial success", async () => {
      let shouldFail = false;
      let callCount = 0;
      const inner: RateLimitStore = {
        get(key: string) {
          if (shouldFail) throw new Error("disconnected");
          return null;
        },
        set(_key: string, _state: StoredState, _ttlMs: number) {
          if (shouldFail) throw new Error("disconnected");
        },
        check(): RateLimitResult {
          callCount++;
          if (shouldFail) throw new Error("disconnected");
          return { allowed: true, limit: 10, remaining: 9, resetMs: 60_000, retryAfterMs: 0 };
        },
      };

      const errors: unknown[] = [];
      const store = new ResilientStore(inner, (e) => errors.push(e));

      const r1 = await store.get("k1");
      expect(r1).toBeNull();
      expect(errors).toHaveLength(0);

      shouldFail = true;

      const r2 = await store.get("k1");
      expect(r2).toBeNull();
      expect(errors).toHaveLength(1);

      const r3 = await store.check("k1", fixedWindowConfig, Date.now(), 60_000);
      expect(r3.allowed).toBe(true);
      expect(errors).toHaveLength(2);
    });
  });

  describe("error types", () => {
    it("handles TypeError", async () => {
      const store = new ResilientStore({
        get() {
          throw new TypeError("Cannot read properties of undefined");
        },
        set() {
          throw new TypeError("Cannot read properties of undefined");
        },
        check() {
          throw new TypeError("Cannot read properties of undefined");
        },
      });
      expect(await store.get("k1")).toBeNull();
    });

    it("handles non-Error thrown values", async () => {
      const store = new ResilientStore({
        get() {
          throw "string error";
        },
        set() {
          throw "string error";
        },
        check() {
          throw "string error";
        },
      });
      expect(await store.get("k1")).toBeNull();
    });
  });

  describe("failMode: closed (deny on error)", () => {
    const error = new Error("down");

    it("throws on get when failMode is closed", async () => {
      const store = new ResilientStore(createFailingStore(error), {
        failMode: "closed",
      });
      await expect(store.get("k1")).rejects.toThrow("down");
    });

    it("throws on set when failMode is closed", async () => {
      const store = new ResilientStore(createFailingStore(error), {
        failMode: "closed",
      });
      await expect(store.set("k1", {}, 1000)).rejects.toThrow("down");
    });

    it("throws on check when failMode is closed", async () => {
      const store = new ResilientStore(createFailingStore(error), {
        failMode: "closed",
      });
      await expect(
        store.check("k1", fixedWindowConfig, Date.now(), 60_000)
      ).rejects.toThrow("down");
    });
  });

  describe("circuit breaker", () => {
    it("opens circuit after threshold failures", async () => {
      let callCount = 0;
      const inner: RateLimitStore = {
        async get() {
          callCount++;
          throw new Error("fail");
        },
        async set() {
          callCount++;
          throw new Error("fail");
        },
        async check() {
          callCount++;
          throw new Error("fail");
        },
      };
      const store = new ResilientStore(inner, {
        threshold: 3,
        cooldownMs: 1000,
      });

      await store.get("a");
      await store.get("b");
      await store.get("c");
      const countAfterTrip = callCount;

      await store.get("d");
      expect(callCount).toBe(countAfterTrip);
    });

    it("retries after cooldown (half-open)", async () => {
      let callCount = 0;
      const inner: RateLimitStore = {
        async get() {
          callCount++;
          throw new Error("fail");
        },
        async set() {
          callCount++;
          throw new Error("fail");
        },
        async check() {
          callCount++;
          throw new Error("fail");
        },
      };
      const store = new ResilientStore(inner, {
        threshold: 2,
        cooldownMs: 50,
      });

      await store.get("a");
      await store.get("b");
      const countAfterTrip = callCount;

      await Bun.sleep(60);

      await store.get("c");
      expect(callCount).toBeGreaterThan(countAfterTrip);
    });

    it("resets failure count on success", async () => {
      let shouldFail = true;
      let callCount = 0;
      const inner: RateLimitStore = {
        async get() {
          callCount++;
          if (shouldFail) throw new Error("fail");
          return { ok: true };
        },
        async set() {
          callCount++;
        },
        async check() {
          callCount++;
          if (shouldFail) throw new Error("fail");
          return { allowed: true, limit: 10, remaining: 9, resetMs: 60_000, retryAfterMs: 0 };
        },
      };
      const store = new ResilientStore(inner, {
        threshold: 3,
        cooldownMs: 1000,
      });

      await store.get("a");
      await store.get("b");
      shouldFail = false;
      await store.get("c");

      shouldFail = true;
      await store.get("d");
      await store.get("e");
      const countBefore = callCount;
      await store.get("f");
      await store.get("g");
      expect(callCount).toBe(countBefore + 1);
    });

    it("circuit open with failMode closed throws", async () => {
      const inner: RateLimitStore = {
        async get() {
          throw new Error("fail");
        },
        async set() {
          throw new Error("fail");
        },
        async check() {
          throw new Error("fail");
        },
      };
      const store = new ResilientStore(inner, {
        failMode: "closed",
        threshold: 1,
        cooldownMs: 5000,
      });

      await expect(store.get("a")).rejects.toThrow("fail");
      await expect(store.get("b")).rejects.toThrow("Circuit open");
    });

    it("circuit open with failMode open returns null", async () => {
      const inner: RateLimitStore = {
        async get() {
          throw new Error("fail");
        },
        async set() {
          throw new Error("fail");
        },
        async check() {
          throw new Error("fail");
        },
      };
      const store = new ResilientStore(inner, {
        failMode: "open",
        threshold: 1,
        cooldownMs: 5000,
      });

      await store.get("a");
      const result = await store.get("b");
      expect(result).toBeNull();
    });
  });

  describe("options object with onError", () => {
    it("calls onError from options object", async () => {
      const errors: unknown[] = [];
      const err = new Error("opts boom");
      const store = new ResilientStore(createFailingStore(err), {
        onError: (e) => errors.push(e),
      });
      await store.get("k1");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(err);
    });
  });
});
