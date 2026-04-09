import { describe, expect, it } from "bun:test";
import type { FixedWindowConfig } from "../../../core/types";
import { fixedWindow } from "../../../core/algorithms/fixed-window";

const config: FixedWindowConfig = {
  algorithm: "fixed-window",
  limit: 3,
  windowMs: 10_000, // 10 seconds
};

describe("fixedWindow", () => {
  // Use a timestamp that aligns to window start for predictability
  const WINDOW_START = Math.floor(1_000_000 / config.windowMs) * config.windowMs;
  const NOW = WINDOW_START + 1000; // 1 second into window

  describe("first request (no prior state)", () => {
    it("allows the request", () => {
      const { result } = fixedWindow(config, null, NOW);
      expect(result.allowed).toBe(true);
    });

    it("remaining is limit minus 1", () => {
      const { result } = fixedWindow(config, null, NOW);
      expect(result.remaining).toBe(config.limit - 1);
    });

    it("limit equals configured limit", () => {
      const { result } = fixedWindow(config, null, NOW);
      expect(result.limit).toBe(config.limit);
    });

    it("retryAfterMs is 0", () => {
      const { result } = fixedWindow(config, null, NOW);
      expect(result.retryAfterMs).toBe(0);
    });

    it("resetMs is time until window end", () => {
      const { result } = fixedWindow(config, null, NOW);
      const windowEnd = WINDOW_START + config.windowMs;
      expect(result.resetMs).toBe(windowEnd - NOW);
    });

    it("stores count and windowStart in state", () => {
      const { state } = fixedWindow(config, null, NOW);
      expect(state).toEqual({ count: 1, windowStart: WINDOW_START });
    });
  });

  describe("consuming all slots in a window", () => {
    it("allows exactly `limit` requests", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        const out = fixedWindow(config, state, NOW + i);
        state = out.state;
        expect(out.result.allowed).toBe(true);
      }
    });

    it("denies the request after limit is reached", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        state = fixedWindow(config, state, NOW + i).state;
      }
      const { result } = fixedWindow(config, state, NOW + config.limit);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("retryAfterMs equals resetMs when denied", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        state = fixedWindow(config, state, NOW + i).state;
      }
      const { result } = fixedWindow(config, state, NOW + config.limit);
      expect(result.retryAfterMs).toBe(result.resetMs);
    });
  });

  describe("window rollover", () => {
    it("resets counter in a new window", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        state = fixedWindow(config, state, NOW + i).state;
      }
      // move to next window
      const nextWindowTime = WINDOW_START + config.windowMs + 1000;
      const { result } = fixedWindow(config, state, nextWindowTime);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(config.limit - 1);
    });

    it("does not carry over count from previous window", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        state = fixedWindow(config, state, NOW).state;
      }
      const nextWindowStart =
        Math.floor((NOW + config.windowMs) / config.windowMs) * config.windowMs;
      const { state: newState } = fixedWindow(
        config,
        state,
        nextWindowStart + 1
      );
      expect((newState as { count: number }).count).toBe(1);
    });
  });

  describe("remaining decrements correctly", () => {
    it("decrements by 1 for each request in the same window", () => {
      let state = null;
      for (let i = 0; i < config.limit; i++) {
        const out = fixedWindow(config, state, NOW);
        state = out.state;
        expect(out.result.remaining).toBe(config.limit - 1 - i);
      }
    });
  });

  describe("resetMs", () => {
    it("decreases as time progresses within window", () => {
      const { result: r1 } = fixedWindow(config, null, WINDOW_START + 1000);
      const { result: r2 } = fixedWindow(config, null, WINDOW_START + 5000);
      expect(r2.resetMs).toBeLessThan(r1.resetMs);
    });

    it("is always positive within a window", () => {
      for (let offset = 0; offset < config.windowMs; offset += 1000) {
        const { result } = fixedWindow(config, null, WINDOW_START + offset);
        expect(result.resetMs).toBeGreaterThan(0);
      }
    });
  });

  describe("single-request limit", () => {
    const singleConfig: FixedWindowConfig = {
      algorithm: "fixed-window",
      limit: 1,
      windowMs: 5000,
    };

    it("allows first, denies second", () => {
      const ws = Math.floor(NOW / singleConfig.windowMs) * singleConfig.windowMs;
      const t = ws + 100;
      const { state, result: r1 } = fixedWindow(singleConfig, null, t);
      expect(r1.allowed).toBe(true);
      const { result: r2 } = fixedWindow(singleConfig, state, t + 1);
      expect(r2.allowed).toBe(false);
    });
  });

  describe("boundary: request at exact window start", () => {
    it("starts a fresh window", () => {
      const { result, state } = fixedWindow(config, null, WINDOW_START);
      expect(result.allowed).toBe(true);
      expect((state as { windowStart: number }).windowStart).toBe(WINDOW_START);
      expect(result.resetMs).toBe(config.windowMs);
    });
  });

  describe("state from a different window is ignored", () => {
    it("treats stale state as fresh start", () => {
      const staleState = {
        count: config.limit, // maxed out
        windowStart: WINDOW_START - config.windowMs, // previous window
      };
      const { result } = fixedWindow(config, staleState, NOW);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(config.limit - 1);
    });
  });
});
