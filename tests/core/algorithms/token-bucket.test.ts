import { describe, expect, it } from "bun:test";
import type { TokenBucketConfig } from "../../../core/types";
import { tokenBucket } from "../../../core/algorithms/token-bucket";

const config: TokenBucketConfig = {
  algorithm: "token-bucket",
  capacity: 5,
  refillRate: 1, // 1 token per second
};

describe("tokenBucket (GCRA)", () => {
  const NOW = 1_000_000;

  describe("first request (no prior state)", () => {
    it("allows the request", () => {
      const { result } = tokenBucket(config, null, NOW);
      expect(result.allowed).toBe(true);
    });

    it("starts with capacity minus one token", () => {
      const { result } = tokenBucket(config, null, NOW);
      expect(result.remaining).toBe(config.capacity - 1);
    });

    it("reports limit equal to capacity", () => {
      const { result } = tokenBucket(config, null, NOW);
      expect(result.limit).toBe(config.capacity);
    });

    it("has zero retryAfterMs", () => {
      const { result } = tokenBucket(config, null, NOW);
      expect(result.retryAfterMs).toBe(0);
    });

    it("stores tat in state", () => {
      const { state } = tokenBucket(config, null, NOW);
      expect(state).toHaveProperty("tat");
      expect((state as { tat: number }).tat).toBeGreaterThan(NOW);
    });
  });

  describe("consuming tokens sequentially", () => {
    it("allows requests until bucket is empty", () => {
      let state = null;
      const results = [];
      for (let i = 0; i < config.capacity; i++) {
        const out = tokenBucket(config, state, NOW);
        state = out.state;
        results.push(out.result);
      }
      expect(results.every((r) => r.allowed)).toBe(true);
      expect(results[results.length - 1]!.remaining).toBe(0);
    });

    it("denies the request after bucket is empty", () => {
      let state = null;
      for (let i = 0; i < config.capacity; i++) {
        state = tokenBucket(config, state, NOW).state;
      }
      const { result } = tokenBucket(config, state, NOW);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("returns positive retryAfterMs when denied", () => {
      let state = null;
      for (let i = 0; i < config.capacity; i++) {
        state = tokenBucket(config, state, NOW).state;
      }
      const { result } = tokenBucket(config, state, NOW);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe("token refill over time", () => {
    it("refills tokens after elapsed time", () => {
      let state = null;
      // exhaust all tokens
      for (let i = 0; i < config.capacity; i++) {
        state = tokenBucket(config, state, NOW).state;
      }
      // advance 2 seconds → should refill 2 tokens at rate 1/s
      const { result } = tokenBucket(config, state, NOW + 2000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });

    it("caps refill at capacity", () => {
      // Exhaust all tokens first, then wait a long time
      let state = null;
      for (let i = 0; i < config.capacity; i++) {
        state = tokenBucket(config, state, NOW).state;
      }
      // advance 100 seconds → would refill 100 tokens, but cap is 5
      const { result } = tokenBucket(config, state, NOW + 100_000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(config.capacity - 1);
    });

    it("partial refill below 1 token still denies", () => {
      let state = null;
      for (let i = 0; i < config.capacity; i++) {
        state = tokenBucket(config, state, NOW).state;
      }
      // advance 500ms → only 0.5 tokens refilled (< 1)
      const { result } = tokenBucket(config, state, NOW + 500);
      expect(result.allowed).toBe(false);
    });
  });

  describe("resetMs", () => {
    it("is positive for allowed requests", () => {
      const { result } = tokenBucket(config, null, NOW);
      expect(result.resetMs).toBeGreaterThan(0);
    });

    it("is positive for denied requests", () => {
      let state = null;
      for (let i = 0; i < config.capacity; i++) {
        state = tokenBucket(config, state, NOW).state;
      }
      const { result } = tokenBucket(config, state, NOW);
      expect(result.resetMs).toBeGreaterThan(0);
    });
  });

  describe("high refill rate", () => {
    const fastConfig: TokenBucketConfig = {
      algorithm: "token-bucket",
      capacity: 100,
      refillRate: 50,
    };

    it("refills quickly", () => {
      let state = null;
      // exhaust all tokens
      for (let i = 0; i < fastConfig.capacity; i++) {
        state = tokenBucket(fastConfig, state, NOW).state;
      }
      // 1 second later → 50 tokens refilled
      const { result } = tokenBucket(fastConfig, state, NOW + 1000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(49);
    });
  });

  describe("single-token capacity", () => {
    const singleConfig: TokenBucketConfig = {
      algorithm: "token-bucket",
      capacity: 1,
      refillRate: 1,
    };

    it("allows first request", () => {
      const { result } = tokenBucket(singleConfig, null, NOW);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it("denies second request immediately", () => {
      const { state } = tokenBucket(singleConfig, null, NOW);
      const { result } = tokenBucket(singleConfig, state, NOW);
      expect(result.allowed).toBe(false);
    });

    it("allows again after 1 second", () => {
      const { state } = tokenBucket(singleConfig, null, NOW);
      const { result } = tokenBucket(singleConfig, state, NOW + 1000);
      expect(result.allowed).toBe(true);
    });
  });

  describe("remaining decrements correctly", () => {
    it("decrements by 1 for each allowed request", () => {
      let state = null;
      for (let i = 0; i < config.capacity; i++) {
        const out = tokenBucket(config, state, NOW);
        state = out.state;
        expect(out.result.remaining).toBe(config.capacity - 1 - i);
      }
    });
  });
});
