import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { MemoryStore } from "../../../core/adapters/memory-store";

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(0); // disable cleanup timer for tests
  });

  afterEach(() => {
    store.dispose();
  });

  describe("get", () => {
    it("returns null for unknown key", () => {
      expect(store.get("missing")).toBeNull();
    });

    it("returns stored state", () => {
      store.set("k1", { count: 1 }, 60_000);
      expect(store.get("k1")).toEqual({ count: 1 });
    });

    it("returns null for expired key", async () => {
      store.set("k1", { count: 1 }, 1); // 1ms TTL
      await Bun.sleep(5);
      expect(store.get("k1")).toBeNull();
    });
  });

  describe("set", () => {
    it("creates a new entry", () => {
      store.set("k1", { v: "a" }, 60_000);
      expect(store.get("k1")).toEqual({ v: "a" });
    });

    it("overwrites existing entry", () => {
      store.set("k1", { v: "a" }, 60_000);
      store.set("k1", { v: "b" }, 60_000);
      expect(store.get("k1")).toEqual({ v: "b" });
    });

    it("respects TTL", async () => {
      store.set("k1", { v: "a" }, 10);
      expect(store.get("k1")).toEqual({ v: "a" });
      await Bun.sleep(15);
      expect(store.get("k1")).toBeNull();
    });
  });

  describe("check", () => {
    it("allows first request (fixed-window)", () => {
      const result = store.check(
        "k1",
        { algorithm: "fixed-window", limit: 10, windowMs: 60_000 },
        Date.now(),
        60_000
      );
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
      expect(result.limit).toBe(10);
    });

    it("denies after limit reached (fixed-window)", () => {
      const now = Date.now();
      const config = { algorithm: "fixed-window" as const, limit: 3, windowMs: 60_000 };
      for (let i = 0; i < 3; i++) {
        store.check("k1", config, now, 60_000);
      }
      const result = store.check("k1", config, now, 60_000);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("stores state after check", () => {
      store.check(
        "k1",
        { algorithm: "fixed-window", limit: 10, windowMs: 60_000 },
        Date.now(),
        60_000
      );
      expect(store.get("k1")).not.toBeNull();
    });

    it("returns RateLimitResult", () => {
      const result = store.check(
        "k1",
        { algorithm: "token-bucket", capacity: 5, refillRate: 1 },
        Date.now(),
        60_000
      );
      expect(result).toHaveProperty("allowed");
      expect(result).toHaveProperty("limit");
      expect(result).toHaveProperty("remaining");
      expect(result).toHaveProperty("resetMs");
      expect(result).toHaveProperty("retryAfterMs");
    });
  });

  describe("size", () => {
    it("reports 0 for empty store", () => {
      expect(store.size).toBe(0);
    });

    it("increments on set", () => {
      store.set("a", {}, 60_000);
      store.set("b", {}, 60_000);
      expect(store.size).toBe(2);
    });

    it("does not increment on overwrite", () => {
      store.set("a", {}, 60_000);
      store.set("a", {}, 60_000);
      expect(store.size).toBe(1);
    });
  });

  describe("dispose", () => {
    it("can be called multiple times safely", () => {
      store.dispose();
      store.dispose();
      // no throw
    });
  });

  describe("eviction via cleanup timer", () => {
    it("removes expired entries on interval", async () => {
      const timedStore = new MemoryStore(50); // 50ms interval
      timedStore.set("k1", { v: 1 }, 10); // expires in 10ms
      timedStore.set("k2", { v: 2 }, 60_000); // stays
      await Bun.sleep(100);
      expect(timedStore.get("k1")).toBeNull();
      expect(timedStore.get("k2")).toEqual({ v: 2 });
      timedStore.dispose();
    });
  });

  describe("concurrent keys", () => {
    it("isolates different keys", () => {
      store.set("a", { v: 1 }, 60_000);
      store.set("b", { v: 2 }, 60_000);
      expect(store.get("a")).toEqual({ v: 1 });
      expect(store.get("b")).toEqual({ v: 2 });
    });
  });

  describe("maxKeys eviction", () => {
    it("evicts entries when maxKeys is exceeded", () => {
      const bounded = new MemoryStore({ cleanupIntervalMs: 0, maxKeys: 3 });
      bounded.set("a", { v: 1 }, 60_000);
      bounded.set("b", { v: 2 }, 60_000);
      bounded.set("c", { v: 3 }, 60_000);
      bounded.set("d", { v: 4 }, 60_000); // triggers eviction
      expect(bounded.size).toBeLessThanOrEqual(3);
      expect(bounded.get("d")).toEqual({ v: 4 });
      bounded.dispose();
    });

    it("evicts oldest (first inserted) entry", () => {
      const bounded = new MemoryStore({ cleanupIntervalMs: 0, maxKeys: 2 });
      bounded.set("first", { v: 1 }, 60_000);
      bounded.set("second", { v: 2 }, 60_000);
      bounded.set("third", { v: 3 }, 60_000); // evicts "first"
      expect(bounded.get("first")).toBeNull();
      expect(bounded.get("second")).toEqual({ v: 2 });
      expect(bounded.get("third")).toEqual({ v: 3 });
      bounded.dispose();
    });

    it("does not evict when updating existing key", () => {
      const bounded = new MemoryStore({ cleanupIntervalMs: 0, maxKeys: 2 });
      bounded.set("a", { v: 1 }, 60_000);
      bounded.set("b", { v: 2 }, 60_000);
      bounded.set("a", { v: 99 }, 60_000); // update, not new key
      expect(bounded.size).toBe(2);
      expect(bounded.get("a")).toEqual({ v: 99 });
      expect(bounded.get("b")).toEqual({ v: 2 });
      bounded.dispose();
    });

    it("does not evict when under maxKeys", () => {
      const bounded = new MemoryStore({ cleanupIntervalMs: 0, maxKeys: 10 });
      bounded.set("a", {}, 60_000);
      bounded.set("b", {}, 60_000);
      expect(bounded.size).toBe(2);
      bounded.dispose();
    });

    it("has no limit when maxKeys is 0 (default)", () => {
      const unbounded = new MemoryStore({ cleanupIntervalMs: 0 });
      for (let i = 0; i < 100; i++) {
        unbounded.set(`k${i}`, {}, 60_000);
      }
      expect(unbounded.size).toBe(100);
      unbounded.dispose();
    });

    it("accepts options object with both fields", () => {
      const bounded = new MemoryStore({
        cleanupIntervalMs: 0,
        maxKeys: 5,
      });
      for (let i = 0; i < 10; i++) {
        bounded.set(`k${i}`, { i }, 60_000);
      }
      expect(bounded.size).toBe(5);
      bounded.dispose();
    });
  });
});
