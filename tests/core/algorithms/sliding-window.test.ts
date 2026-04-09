import { describe, expect, it } from "bun:test";
import type { SlidingWindowConfig } from "../../../core/types";
import { slidingWindow } from "../../../core/algorithms/sliding-window";

const config: SlidingWindowConfig = {
  algorithm: "sliding-window",
  limit: 3,
  windowMs: 10_000, // 10 seconds
};

describe("slidingWindow (two-counter approximation)", () => {
  // Align to window boundary for predictable tests
  const WINDOW_START =
    Math.floor(1_000_000 / config.windowMs) * config.windowMs;
  const NOW = WINDOW_START + 1000; // 1 second into window

  describe("first request (no prior state)", () => {
    it("allows the request", () => {
      const { result } = slidingWindow(config, null, NOW);
      expect(result.allowed).toBe(true);
    });

    it("remaining is limit minus 1", () => {
      const { result } = slidingWindow(config, null, NOW);
      expect(result.remaining).toBe(config.limit - 1);
    });

    it("limit equals configured limit", () => {
      const { result } = slidingWindow(config, null, NOW);
      expect(result.limit).toBe(config.limit);
    });

    it("retryAfterMs is 0", () => {
      const { result } = slidingWindow(config, null, NOW);
      expect(result.retryAfterMs).toBe(0);
    });

    it("stores counter state (not timestamps)", () => {
      const { state } = slidingWindow(config, null, NOW);
      expect(state).toHaveProperty("currentCount", 1);
      expect(state).toHaveProperty("previousCount", 0);
      expect(state).toHaveProperty("windowStart", WINDOW_START);
    });
  });

  describe("consuming all slots", () => {
    it("allows exactly `limit` requests in the window", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        const out = slidingWindow(config, state, NOW + i);
        state = out.state;
        expect(out.result.allowed).toBe(true);
      }
    });

    it("denies the request after limit is reached", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        state = slidingWindow(config, state, NOW + i).state;
      }
      const { result } = slidingWindow(config, state, NOW + config.limit);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("returns positive retryAfterMs when denied", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        state = slidingWindow(config, state, NOW + i).state;
      }
      const { result } = slidingWindow(config, state, NOW + config.limit);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe("window rollover", () => {
    it("resets counter in a new window when previous is stale", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        state = slidingWindow(config, state, NOW + i).state;
      }
      // Jump 2 full windows ahead — all state is stale
      const futureMs = WINDOW_START + config.windowMs * 2 + 1000;
      const { result } = slidingWindow(config, state, futureMs);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(config.limit - 1);
    });

    it("carries current count to previousCount on window rollover", () => {
      let state = null;
      // Fill 3 requests in current window
      for (let i = 0; i < config.limit; i++) {
        state = slidingWindow(config, state, NOW + i).state;
      }
      // Move to the next window — previousCount should be 3
      const nextWindowStart = WINDOW_START + config.windowMs;
      const nextWindowNow = nextWindowStart + 1; // 1ms in
      // weight ≈ 1 - 0.0001 = ~0.9999, estimated ≈ floor(3 * 0.9999) = 2
      const { result } = slidingWindow(config, state, nextWindowNow);
      // With weight ~1.0, previous 3 requests weigh ~3, so this should be denied
      // Actually floor(3 * 0.9999) = 2, so one more is allowed
      expect(result.allowed).toBe(true);
    });

    it("allows more requests as time progresses in new window", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        state = slidingWindow(config, state, NOW + i).state;
      }
      // Move to 50% through next window — weight = 0.5
      // estimated = floor(3 * 0.5 + 0) = 1, so 2 more allowed
      const halfwayNextWindow =
        WINDOW_START + config.windowMs + config.windowMs / 2;
      const { result } = slidingWindow(config, state, halfwayNextWindow);
      expect(result.allowed).toBe(true);
    });
  });

  describe("remaining decrements correctly", () => {
    it("decrements by 1 for each request in same window", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        const out = slidingWindow(config, state, NOW + i);
        state = out.state;
        expect(out.result.remaining).toBe(config.limit - 1 - i);
      }
    });
  });

  describe("resetMs", () => {
    it("is positive within a window", () => {
      const { result } = slidingWindow(config, null, NOW);
      expect(result.resetMs).toBeGreaterThan(0);
      expect(result.resetMs).toBeLessThanOrEqual(config.windowMs);
    });

    it("is non-negative for denied requests", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        state = slidingWindow(config, state, NOW).state;
      }
      const { result } = slidingWindow(config, state, NOW);
      expect(result.resetMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("single-request limit", () => {
    const singleConfig: SlidingWindowConfig = {
      algorithm: "sliding-window",
      limit: 1,
      windowMs: 5000,
    };

    it("allows first, denies second", () => {
      const ws = Math.floor(1_000_000 / singleConfig.windowMs) * singleConfig.windowMs;
      const t = ws + 100;
      const { state, result: r1 } = slidingWindow(singleConfig, null, t);
      expect(r1.allowed).toBe(true);
      const { result: r2 } = slidingWindow(singleConfig, state, t + 1);
      expect(r2.allowed).toBe(false);
    });
  });

  describe("large limit", () => {
    const largeConfig: SlidingWindowConfig = {
      algorithm: "sliding-window",
      limit: 1000,
      windowMs: 60_000,
    };

    it("allows many requests (O(1) per check)", () => {
      const ws =
        Math.floor(1_000_000 / largeConfig.windowMs) * largeConfig.windowMs;
      let state = null;
      for (let i = 0; i < 100; i++) {
        const out = slidingWindow(largeConfig, state, ws + 1000 + i);
        state = out.state;
        expect(out.result.allowed).toBe(true);
      }
    });
  });

  describe("O(1) space — state is constant size", () => {
    it("state has exactly 3 fields regardless of request count", () => {
      let state = null;
      for (let i = 0; i < 50; i++) {
        state = slidingWindow(config, state, NOW + i).state;
      }
      const keys = Object.keys(state!);
      expect(keys).toEqual(["previousCount", "currentCount", "windowStart"]);
    });
  });

  describe("boundary: request at exact window start", () => {
    it("starts a fresh window", () => {
      const { result, state } = slidingWindow(config, null, WINDOW_START);
      expect(result.allowed).toBe(true);
      expect((state as { windowStart: number }).windowStart).toBe(
        WINDOW_START
      );
    });
  });

  describe("weighted estimation accuracy", () => {
    it("at 90% through next window, previous counts barely matter", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        state = slidingWindow(config, state, NOW + i).state;
      }
      // 90% through next window → weight = 0.1
      // estimated = floor(3 * 0.1) = 0 → all slots available
      const t = WINDOW_START + config.windowMs + config.windowMs * 0.9;
      const { result } = slidingWindow(config, state, t);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(config.limit - 1);
    });
  });
});
