# Rate Limiter Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 5 production issues: Redis race condition, MemoryStore unbounded growth, Redis timeout, sliding window O(n), and add circuit breaker with configurable fail behavior.

**Architecture:** Each fix is isolated to its own adapter/algorithm file with no cross-dependencies. ResilientStore gains a circuit breaker + `failMode` option. RedisStore uses a Lua CAS (compare-and-swap) loop for atomicity. MemoryStore adds `maxKeys` with random eviction. Sliding window switches to the two-counter approximation (O(1)). All changes are backwards-compatible — new constructor params are optional with sensible defaults.

**Tech Stack:** Bun, TypeScript, Elysia, bun:test

---

### Task 1: Redis Atomic CAS — Fix Race Condition

**Files:**
- Modify: `core/adapters/redis-store.ts:18-60`
- Modify: `core/types.ts:22-30` (add `getAndSet` contract note)
- Test: `tests/core/adapters/redis-store.test.ts`

The current `getAndSet` does a separate `get()` then `eval(SET)`. Two concurrent requests can both read the same state and both write, skipping a count. Fix: use a Lua CAS script that atomically checks the current value matches what we read, then writes. Retry on conflict.

**Step 1: Write the failing test**

Add to `tests/core/adapters/redis-store.test.ts`:

```ts
describe("atomic getAndSet (CAS)", () => {
  it("retries on concurrent modification", async () => {
    const mockRedis = createMockRedis();
    const store = new RedisStore(mockRedis);

    // Pre-seed state
    await store.set("k1", { count: 0 }, 60_000);

    // Simulate: first CAS attempt fails because another writer changed the value
    let evalCallCount = 0;
    const originalEval = mockRedis.eval.bind(mockRedis);
    mockRedis.eval = async (script: string, numkeys: number, ...args: string[]) => {
      evalCallCount++;
      if (evalCallCount === 1) {
        // Simulate conflict: change the stored value before CAS completes
        mockRedis.data.set("rl:k1", {
          value: JSON.stringify({ count: 99 }),
          expiresAt: Date.now() + 60_000,
        });
        return "__CAS_CONFLICT__";
      }
      return originalEval(script, numkeys, ...args);
    };

    const result = await store.getAndSet(
      "k1",
      (current) => ({ count: ((current as any)?.count ?? 0) + 1 }),
      60_000
    );

    // Should have retried with the conflicted value (99) and produced 100
    expect(result).toEqual({ count: 100 });
    expect(evalCallCount).toBe(2); // 1 failed CAS + 1 success
  });

  it("gives up after maxRetries", async () => {
    const mockRedis = createMockRedis();
    const store = new RedisStore(mockRedis, "rl:", 3);

    await store.set("k1", { count: 0 }, 60_000);

    // Always conflict
    mockRedis.eval = async () => "__CAS_CONFLICT__";

    await expect(
      store.getAndSet("k1", (c) => ({ count: ((c as any)?.count ?? 0) + 1 }), 60_000)
    ).rejects.toThrow("CAS");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/core/adapters/redis-store.test.ts`
Expected: FAIL — current RedisStore doesn't retry or use CAS

**Step 3: Implement the CAS Lua script and retry loop**

Replace `core/adapters/redis-store.ts` Lua script and `getAndSet`:

```ts
const LUA_CAS = `
local key = KEYS[1]
local expected = ARGV[1]
local newState = ARGV[2]
local ttlMs = tonumber(ARGV[3])
local current = redis.call('GET', key)
local cmp = current or '__null__'
if cmp == expected then
  redis.call('SET', key, newState, 'PX', ttlMs)
  return newState
end
return '__CAS_CONFLICT__'
`;

export class RedisStore implements RateLimitStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly prefix: string = "rl:",
    private readonly maxCasRetries: number = 5
  ) {}

  // ... get and set unchanged ...

  async getAndSet(
    key: string,
    updater: (current: StoredState | null) => StoredState,
    ttlMs: number
  ): Promise<StoredState> {
    const fullKey = this.prefix + key;
    let raw = await this.redis.get(fullKey);
    
    for (let attempt = 0; attempt < this.maxCasRetries; attempt++) {
      const current: StoredState | null = raw ? (JSON.parse(raw) as StoredState) : null;
      const next = updater(current);
      const expected = raw ?? "__null__";
      const newJson = JSON.stringify(next);

      const casResult = await this.redis.eval(
        LUA_CAS, 1, fullKey, expected, newJson, String(ttlMs)
      );

      if (casResult !== "__CAS_CONFLICT__") {
        return next;
      }
      // Conflict — re-read for next attempt
      raw = await this.redis.get(fullKey);
    }

    throw new Error(`CAS conflict after ${this.maxCasRetries} retries on key "${fullKey}"`);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/core/adapters/redis-store.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add core/adapters/redis-store.ts tests/core/adapters/redis-store.test.ts
git commit -m "fix: atomic CAS in RedisStore.getAndSet to prevent race condition"
```

---

### Task 2: MemoryStore Max Keys — Prevent Unbounded Growth

**Files:**
- Modify: `core/adapters/memory-store.ts`
- Test: `tests/core/adapters/memory-store.test.ts`

An attacker spoofing millions of IPs can OOM the process. Add a `maxKeys` option. When exceeded, randomly evict entries to make room. Random eviction is O(1) and nearly as effective as LRU for rate limiting (expired entries are likely stale anyway).

**Step 1: Write the failing test**

Add to `tests/core/adapters/memory-store.test.ts`:

```ts
describe("maxKeys eviction", () => {
  it("evicts entries when maxKeys is exceeded", () => {
    const store = new MemoryStore({ cleanupIntervalMs: 0, maxKeys: 3 });
    store.set("a", { v: 1 }, 60_000);
    store.set("b", { v: 2 }, 60_000);
    store.set("c", { v: 3 }, 60_000);
    store.set("d", { v: 4 }, 60_000); // triggers eviction
    expect(store.size).toBeLessThanOrEqual(3);
    // the new key must exist
    expect(store.get("d")).toEqual({ v: 4 });
  });

  it("does not evict when under maxKeys", () => {
    const store = new MemoryStore({ cleanupIntervalMs: 0, maxKeys: 10 });
    store.set("a", {}, 60_000);
    store.set("b", {}, 60_000);
    expect(store.size).toBe(2);
    store.dispose();
  });

  it("has no limit when maxKeys is 0 (default)", () => {
    const store = new MemoryStore({ cleanupIntervalMs: 0 });
    for (let i = 0; i < 100; i++) {
      store.set(`k${i}`, {}, 60_000);
    }
    expect(store.size).toBe(100);
    store.dispose();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/core/adapters/memory-store.test.ts`
Expected: FAIL — MemoryStore constructor doesn't accept options object

**Step 3: Add maxKeys with random eviction**

Modify `core/adapters/memory-store.ts`:
- Change constructor to accept an options object (backwards-compat: still accept number)
- Add `maxKeys` field
- In `set()`, if `maxKeys > 0 && this.map.size >= this.maxKeys`, evict a random entry before inserting

```ts
interface MemoryStoreOptions {
  cleanupIntervalMs?: number;
  maxKeys?: number;
}

export class MemoryStore implements RateLimitStore {
  private readonly map = new Map<string, Entry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly maxKeys: number;

  constructor(options: MemoryStoreOptions | number = {}) {
    const opts = typeof options === "number"
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

  set(key: string, state: StoredState, ttlMs: number): void {
    if (this.maxKeys > 0 && !this.map.has(key) && this.map.size >= this.maxKeys) {
      this.evictRandom();
    }
    this.map.set(key, { state, expiresAt: Date.now() + ttlMs });
  }

  private evictRandom(): void {
    // Evict first key found (Map iteration order = insertion order, effectively random for our use case)
    const firstKey = this.map.keys().next().value;
    if (firstKey !== undefined) {
      this.map.delete(firstKey);
    }
  }

  // ... rest unchanged ...
}
```

**Step 4: Run tests**

Run: `bun test tests/core/adapters/memory-store.test.ts`
Expected: ALL PASS (existing tests use `new MemoryStore(0)` which still works)

**Step 5: Commit**

```bash
git add core/adapters/memory-store.ts tests/core/adapters/memory-store.test.ts
git commit -m "feat: add maxKeys to MemoryStore to prevent unbounded memory growth"
```

---

### Task 3: RedisStore Timeout

**Files:**
- Modify: `core/adapters/redis-store.ts`
- Test: `tests/core/adapters/redis-store.test.ts`

If Redis hangs, every request hangs forever. Add a `timeoutMs` option that races all Redis calls against a timer.

**Step 1: Write the failing test**

Add to `tests/core/adapters/redis-store.test.ts`:

```ts
describe("timeoutMs option", () => {
  it("rejects get after timeout", async () => {
    const store = new RedisStore(createHangingRedis(5000), "rl:", 5, 50);
    await expect(store.get("k1")).rejects.toThrow("timed out");
  });

  it("rejects set after timeout", async () => {
    const store = new RedisStore(createHangingRedis(5000), "rl:", 5, 50);
    await expect(store.set("k1", {}, 1000)).rejects.toThrow("timed out");
  });

  it("rejects getAndSet after timeout", async () => {
    const store = new RedisStore(createHangingRedis(5000), "rl:", 5, 50);
    await expect(
      store.getAndSet("k1", () => ({}), 1000)
    ).rejects.toThrow("timed out");
  });

  it("does not timeout when Redis is fast", async () => {
    const store = new RedisStore(createMockRedis(), "rl:", 5, 5000);
    await store.set("k1", { v: 1 }, 60_000);
    const result = await store.get("k1");
    expect(result).toEqual({ v: 1 });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/core/adapters/redis-store.test.ts`
Expected: FAIL — RedisStore constructor doesn't accept 4th arg

**Step 3: Add timeoutMs with Promise.race**

Add to `RedisStore` constructor a 4th param `timeoutMs: number = 0`. Add a private helper:

```ts
private withTimeout<T>(promise: Promise<T>): Promise<T> {
  if (this.timeoutMs <= 0) return promise;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Redis operation timed out after ${this.timeoutMs}ms`)), this.timeoutMs)
    ),
  ]);
}
```

Wrap all `this.redis.*` calls with `this.withTimeout(...)`.

**Step 4: Run tests**

Run: `bun test tests/core/adapters/redis-store.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add core/adapters/redis-store.ts tests/core/adapters/redis-store.test.ts
git commit -m "feat: add timeoutMs to RedisStore to prevent hanging on slow Redis"
```

---

### Task 4: Sliding Window O(1) Approximation

**Files:**
- Modify: `core/algorithms/sliding-window.ts`
- Test: `tests/core/algorithms/sliding-window.test.ts`

Current implementation stores every timestamp → O(n) time and space. Replace with the standard two-counter approximation: keep current + previous window counts, estimate using weighted average. Exact same interface, O(1) per check, O(1) per key.

Formula: `estimatedCount = previousCount * (1 - elapsedRatio) + currentCount`

**Step 1: Update the tests**

The existing tests check `state.timestamps` directly in one test — update that test to check `state.currentCount` instead. All behavior tests (allow/deny/remaining) should still pass because the approximation is accurate for the tested scenarios.

Update in `tests/core/algorithms/sliding-window.test.ts`:

```ts
it("stores counter state (not timestamps)", () => {
  const { state } = slidingWindow(config, null, NOW);
  expect(state).toHaveProperty("currentCount");
  expect(state).toHaveProperty("windowStart");
});
```

**Step 2: Rewrite the algorithm**

Replace `core/algorithms/sliding-window.ts`:

```ts
import type { AlgorithmFn, RateLimitResult, SlidingWindowConfig, StoredState } from "../types";

interface SlidingWindowState extends StoredState {
  previousCount: number;
  currentCount: number;
  windowStart: number;
}

export const slidingWindow: AlgorithmFn<SlidingWindowConfig> = (
  config, current, nowMs
): { state: StoredState; result: RateLimitResult } => {
  const { limit, windowMs } = config;
  const prev = current as SlidingWindowState | null;

  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const elapsed = nowMs - windowStart;
  const weight = 1 - elapsed / windowMs;

  let previousCount: number;
  let currentCount: number;

  if (!prev) {
    previousCount = 0;
    currentCount = 0;
  } else if (prev.windowStart === windowStart) {
    previousCount = prev.previousCount;
    currentCount = prev.currentCount;
  } else if (prev.windowStart === windowStart - windowMs) {
    previousCount = prev.currentCount;
    currentCount = 0;
  } else {
    previousCount = 0;
    currentCount = 0;
  }

  const estimated = Math.floor(previousCount * weight + currentCount);

  if (estimated >= limit) {
    const resetMs = windowStart + windowMs - nowMs;
    const retryAfterMs = resetMs;
    return {
      state: { previousCount, currentCount, windowStart } satisfies SlidingWindowState,
      result: { allowed: false, limit, remaining: 0, resetMs: Math.max(0, resetMs), retryAfterMs: Math.max(0, retryAfterMs) },
    };
  }

  currentCount += 1;
  const newEstimated = Math.floor(previousCount * weight + currentCount);
  const remaining = Math.max(0, limit - newEstimated);
  const resetMs = windowStart + windowMs - nowMs;

  return {
    state: { previousCount, currentCount, windowStart } satisfies SlidingWindowState,
    result: { allowed: true, limit, remaining, resetMs: Math.max(0, resetMs), retryAfterMs: 0 },
  };
};
```

**Step 3: Run tests, adjust any that relied on exact timestamp behavior**

Run: `bun test tests/core/algorithms/sliding-window.test.ts`
Some tests may need adjustment for the approximation. The key behavioral tests (allow N, deny N+1, allow after window) must pass.

**Step 4: Commit**

```bash
git add core/algorithms/sliding-window.ts tests/core/algorithms/sliding-window.test.ts
git commit -m "perf: O(1) sliding window using two-counter approximation"
```

---

### Task 5: Circuit Breaker + Configurable Fail Behavior

**Files:**
- Modify: `core/adapters/resilient-store.ts`
- Test: `tests/core/adapters/resilient-store.test.ts`

Add:
- `failMode: "open" | "closed"` — open = allow traffic (default, as user requested), closed = deny traffic
- Circuit breaker: after `threshold` consecutive failures, enter "open circuit" state for `cooldownMs`. During cooldown, don't even try the inner store — immediately apply failMode behavior. After cooldown, try again (half-open).

**Step 1: Write the failing tests**

Add to `tests/core/adapters/resilient-store.test.ts`:

```ts
describe("failMode: closed (deny on error)", () => {
  it("throws on get when failMode is closed", async () => {
    const store = new ResilientStore(createFailingStore(new Error("down")), { failMode: "closed" });
    await expect(store.get("k1")).rejects.toThrow("down");
  });

  it("throws on getAndSet when failMode is closed", async () => {
    const store = new ResilientStore(createFailingStore(new Error("down")), { failMode: "closed" });
    await expect(store.getAndSet("k1", () => ({}), 1000)).rejects.toThrow("down");
  });
});

describe("circuit breaker", () => {
  it("opens circuit after threshold failures", async () => {
    let callCount = 0;
    const inner: RateLimitStore = {
      async get() { callCount++; throw new Error("fail"); },
      async set() { callCount++; throw new Error("fail"); },
      async getAndSet() { callCount++; throw new Error("fail"); },
    };
    const store = new ResilientStore(inner, { threshold: 3, cooldownMs: 1000 });

    // 3 failures to trip the breaker
    await store.get("a");
    await store.get("b");
    await store.get("c");
    const countAfterTrip = callCount;

    // next call should NOT hit inner store (circuit is open)
    await store.get("d");
    expect(callCount).toBe(countAfterTrip);
  });

  it("retries after cooldown (half-open)", async () => {
    let callCount = 0;
    const inner: RateLimitStore = {
      async get() { callCount++; throw new Error("fail"); },
      async set() { callCount++; throw new Error("fail"); },
      async getAndSet() { callCount++; throw new Error("fail"); },
    };
    const store = new ResilientStore(inner, { threshold: 2, cooldownMs: 50 });

    await store.get("a");
    await store.get("b"); // trips breaker
    const countAfterTrip = callCount;

    await Bun.sleep(60); // wait for cooldown

    await store.get("c"); // half-open: tries inner store again
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
      async set() { callCount++; },
      async getAndSet(_k, updater) {
        callCount++;
        if (shouldFail) throw new Error("fail");
        return updater(null);
      },
    };
    const store = new ResilientStore(inner, { threshold: 3, cooldownMs: 1000 });

    await store.get("a"); // fail 1
    await store.get("b"); // fail 2
    shouldFail = false;
    await store.get("c"); // success — resets counter

    shouldFail = true;
    await store.get("d"); // fail 1 again
    await store.get("e"); // fail 2 again
    // NOT tripped yet (only 2, threshold is 3)
    const countBefore = callCount;
    await store.get("f"); // fail 3 — NOW tripped
    await store.get("g"); // circuit open — should NOT call inner
    expect(callCount).toBe(countBefore + 1); // only the trip call, not g
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/core/adapters/resilient-store.test.ts`
Expected: FAIL — constructor signature changed

**Step 3: Implement circuit breaker**

Rewrite `core/adapters/resilient-store.ts`:

```ts
import type { RateLimitStore, StoredState } from "../types";

interface ResilientStoreOptions {
  onError?: (error: unknown) => void;
  failMode?: "open" | "closed";
  threshold?: number;
  cooldownMs?: number;
}

export class ResilientStore implements RateLimitStore {
  private readonly store: RateLimitStore;
  private readonly onError?: (error: unknown) => void;
  private readonly failMode: "open" | "closed";
  private readonly threshold: number;
  private readonly cooldownMs: number;

  private failures = 0;
  private circuitOpenUntil = 0;

  constructor(store: RateLimitStore, options?: ResilientStoreOptions | ((error: unknown) => void)) {
    this.store = store;
    if (typeof options === "function") {
      // backwards compat: new ResilientStore(store, onError)
      this.onError = options;
      this.failMode = "open";
      this.threshold = 0;
      this.cooldownMs = 0;
    } else {
      this.onError = options?.onError;
      this.failMode = options?.failMode ?? "open";
      this.threshold = options?.threshold ?? 0;
      this.cooldownMs = options?.cooldownMs ?? 30_000;
    }
  }

  private isCircuitOpen(): boolean {
    if (this.threshold <= 0) return false;
    if (this.failures < this.threshold) return false;
    return Date.now() < this.circuitOpenUntil;
  }

  private recordFailure(error: unknown): void {
    this.onError?.(error);
    if (this.threshold > 0) {
      this.failures++;
      if (this.failures >= this.threshold) {
        this.circuitOpenUntil = Date.now() + this.cooldownMs;
      }
    }
  }

  private recordSuccess(): void {
    this.failures = 0;
  }

  async get(key: string): Promise<StoredState | null> {
    if (this.isCircuitOpen()) {
      return this.failMode === "open" ? null : Promise.reject(new Error("Circuit open"));
    }
    try {
      const result = await this.store.get(key);
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error);
      if (this.failMode === "closed") throw error;
      return null;
    }
  }

  async set(key: string, state: StoredState, ttlMs: number): Promise<void> {
    if (this.isCircuitOpen()) {
      if (this.failMode === "closed") throw new Error("Circuit open");
      return;
    }
    try {
      await this.store.set(key, state, ttlMs);
      this.recordSuccess();
    } catch (error) {
      this.recordFailure(error);
      if (this.failMode === "closed") throw error;
    }
  }

  async getAndSet(
    key: string,
    updater: (current: StoredState | null) => StoredState,
    ttlMs: number
  ): Promise<StoredState> {
    if (this.isCircuitOpen()) {
      if (this.failMode === "closed") throw new Error("Circuit open");
      return updater(null);
    }
    try {
      const result = await this.store.getAndSet(key, updater, ttlMs);
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error);
      if (this.failMode === "closed") throw error;
      return updater(null);
    }
  }
}
```

**Step 4: Run all tests**

Run: `bun test`
Expected: ALL PASS (existing tests use `new ResilientStore(store)` or `new ResilientStore(store, fn)` — both still work)

**Step 5: Commit**

```bash
git add core/adapters/resilient-store.ts tests/core/adapters/resilient-store.test.ts
git commit -m "feat: circuit breaker + configurable failMode (open/closed) in ResilientStore"
```

---

### Task 6: Update Exports & Final Integration Test

**Files:**
- Verify: `index.ts` (no changes needed — all exports are by name)
- Test: `tests/plugin/elysia-plugin.test.ts`

Add one integration test combining circuit breaker + failMode + plugin:

```ts
describe("circuit breaker integration", () => {
  it("fast-fails and allows traffic after circuit trips", async () => {
    let callCount = 0;
    const brokenStore: RateLimitStore = {
      async get() { callCount++; throw new Error("down"); },
      async set() { callCount++; throw new Error("down"); },
      async getAndSet() { callCount++; throw new Error("down"); },
    };
    const resilient = new ResilientStore(brokenStore, { threshold: 2, cooldownMs: 5000 });
    const app = createApp({
      algorithm: { algorithm: "token-bucket", capacity: 1, refillRate: 1 },
      store: resilient,
    });

    // First 2 requests trip the breaker
    await app.handle(request("/test", { "x-forwarded-for": "cb.1" }));
    await app.handle(request("/test", { "x-forwarded-for": "cb.2" }));
    const countAfterTrip = callCount;

    // Next requests don't even hit the store
    const res = await app.handle(request("/test", { "x-forwarded-for": "cb.3" }));
    expect(res.status).toBe(200); // fail-open
    expect(callCount).toBe(countAfterTrip); // no new calls to broken store
  });
});
```

Run: `bun test`
Expected: ALL PASS

Commit: `git commit -m "test: circuit breaker integration test"`
