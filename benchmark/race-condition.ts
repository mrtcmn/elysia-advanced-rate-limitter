/**
 * Race condition benchmark: concurrent "workers" hit the same key simultaneously.
 * Verifies that the store + algorithm correctly counts every request.
 * Uses real Redis to test atomic Lua script correctness under contention.
 *
 * Run: bun run bench:race
 */
import { MemoryStore } from "../core/adapters/memory-store";
import { RedisStore } from "../core/adapters/redis-store";
import type {
  AlgorithmConfig,
  RateLimitStore,
} from "../core/types";
import {
  concurrentBench,
  createRedisClient,
  fail,
  flushPrefix,
  fmt,
  fmtMs,
  header,
  metric,
  pass,
  separator,
  subheader,
  warn,
} from "./helpers";

// ─── Test: concurrent requests on a single key must not over-count ──────────

async function testConcurrentAccuracy(
  label: string,
  store: RateLimitStore,
  config: AlgorithmConfig,
  concurrency: number,
  opsPerWorker: number
) {
  subheader(`${label} (${concurrency} workers × ${opsPerWorker} ops)`);

  let allowed = 0;
  let denied = 0;
  let errors = 0;

  const result = await concurrentBench(
    label,
    concurrency,
    opsPerWorker,
    async () => {
      try {
        const r = await store.check("race-key", config, Date.now(), 60_000);
        if (r.allowed) allowed++;
        else denied++;
      } catch (e) {
        errors++;
      }
    }
  );

  const total = allowed + denied;
  metric("total requests", fmt(total));
  metric("allowed", fmt(allowed));
  metric("denied", fmt(denied));
  if (errors > 0) metric("errors", fmt(errors));
  metric("ops/sec", fmt(result.opsPerSec));
  metric("p50 latency", fmtMs(result.p50Ms));
  metric("p99 latency", fmtMs(result.p99Ms));

  return { allowed, denied, errors, total, result };
}

// ─── MemoryStore race test ──────────────────────────────────────────────────

async function raceMemoryStore() {
  header("Race Condition: MemoryStore (synchronous, no races expected)");

  const limit = 50;

  // Fixed window
  {
    const store = new MemoryStore(0);
    const config: AlgorithmConfig = {
      algorithm: "fixed-window",
      limit,
      windowMs: 60_000,
    };
    const { allowed } = await testConcurrentAccuracy(
      "fixed-window",
      store,
      config,
      10,
      20
    );
    if (allowed === limit) pass(`Exactly ${limit} allowed (correct)`);
    else if (allowed <= limit)
      warn(`${allowed} allowed, expected exactly ${limit}`);
    else fail(`${allowed} allowed, exceeds limit ${limit}! RACE CONDITION`);
    store.dispose();
    separator();
  }

  // Token bucket
  {
    const store = new MemoryStore(0);
    const config: AlgorithmConfig = {
      algorithm: "token-bucket",
      capacity: limit,
      refillRate: 0.001,
    };
    const { allowed } = await testConcurrentAccuracy(
      "token-bucket",
      store,
      config,
      10,
      20
    );
    if (allowed <= limit + 1)
      pass(`${allowed} allowed, within tolerance of ${limit}`);
    else fail(`${allowed} allowed, exceeds capacity ${limit}! RACE CONDITION`);
    store.dispose();
    separator();
  }

  // Sliding window
  {
    const store = new MemoryStore(0);
    const config: AlgorithmConfig = {
      algorithm: "sliding-window",
      limit,
      windowMs: 60_000,
    };
    const { allowed } = await testConcurrentAccuracy(
      "sliding-window",
      store,
      config,
      10,
      20
    );
    if (allowed === limit) pass(`Exactly ${limit} allowed (correct)`);
    else if (allowed <= limit) warn(`${allowed} allowed, expected ${limit}`);
    else fail(`${allowed} allowed, exceeds limit ${limit}! RACE CONDITION`);
    store.dispose();
    separator();
  }
}

// ─── Real Redis race test ───────────────────────────────────────────────────

async function raceRedisStore() {
  header("Race Condition: Real Redis (atomic Lua scripts under contention)");

  const redis = createRedisClient();
  await redis.connect();
  const limit = 50;

  // Fixed window
  {
    const prefix = "bench:race:fw:";
    await flushPrefix(redis, prefix);
    const store = new RedisStore(redis as any, prefix);

    const config: AlgorithmConfig = {
      algorithm: "fixed-window",
      limit,
      windowMs: 60_000,
    };
    const { allowed, errors } = await testConcurrentAccuracy(
      "redis + fixed-window",
      store,
      config,
      10,
      20
    );
    if (errors > 0) warn(`${errors} errors`);
    if (allowed === limit)
      pass(`Exactly ${limit} allowed — atomicity correct`);
    else if (allowed <= limit)
      warn(`${allowed} allowed, expected ${limit}`);
    else fail(`${allowed} allowed, exceeds limit ${limit}! ATOMICITY BROKEN`);
    await flushPrefix(redis, prefix);
    separator();
  }

  // Token bucket
  {
    const prefix = "bench:race:tb:";
    await flushPrefix(redis, prefix);
    const store = new RedisStore(redis as any, prefix);

    const config: AlgorithmConfig = {
      algorithm: "token-bucket",
      capacity: limit,
      refillRate: 0.001,
    };
    const { allowed, errors } = await testConcurrentAccuracy(
      "redis + token-bucket",
      store,
      config,
      10,
      20
    );
    if (errors > 0) warn(`${errors} errors`);
    if (allowed <= limit + 1)
      pass(`${allowed} allowed, within tolerance of ${limit}`);
    else fail(`${allowed} allowed, exceeds capacity ${limit}! ATOMICITY BROKEN`);
    await flushPrefix(redis, prefix);
    separator();
  }

  // Sliding window
  {
    const prefix = "bench:race:sw:";
    await flushPrefix(redis, prefix);
    const store = new RedisStore(redis as any, prefix);

    const config: AlgorithmConfig = {
      algorithm: "sliding-window",
      limit,
      windowMs: 60_000,
    };
    const { allowed, errors } = await testConcurrentAccuracy(
      "redis + sliding-window",
      store,
      config,
      10,
      20
    );
    if (errors > 0) warn(`${errors} errors`);
    if (allowed === limit)
      pass(`Exactly ${limit} allowed — atomicity correct`);
    else if (allowed <= limit)
      warn(`${allowed} allowed, expected ${limit}`);
    else fail(`${allowed} allowed, exceeds limit ${limit}! ATOMICITY BROKEN`);
    await flushPrefix(redis, prefix);
    separator();
  }

  await redis.quit();
}

// ─── High-concurrency stress test ───────────────────────────────────────────

async function raceHighConcurrency() {
  header("Race Condition: High Concurrency Stress (50 workers × 100 ops)");

  const limit = 100;

  // Memory
  {
    const store = new MemoryStore(0);
    const config: AlgorithmConfig = {
      algorithm: "fixed-window",
      limit,
      windowMs: 60_000,
    };
    const { allowed } = await testConcurrentAccuracy(
      "memory + fixed-window (stress)",
      store,
      config,
      50,
      100
    );
    if (allowed === limit)
      pass(`Exactly ${limit} allowed under 50-way concurrency`);
    else if (allowed <= limit)
      warn(`${allowed} allowed (under limit, possible timing)`);
    else fail(`${allowed} allowed — exceeds limit ${limit}!`);
    store.dispose();
    separator();
  }

  // Redis
  {
    const redis = createRedisClient();
    await redis.connect();
    const prefix = "bench:race:stress:";
    await flushPrefix(redis, prefix);
    const store = new RedisStore(redis as any, prefix);

    const config: AlgorithmConfig = {
      algorithm: "fixed-window",
      limit,
      windowMs: 60_000,
    };
    const { allowed, errors } = await testConcurrentAccuracy(
      "redis + fixed-window (stress)",
      store,
      config,
      50,
      100
    );
    if (errors > 0) warn(`${errors} errors under high contention`);
    if (allowed <= limit)
      pass(`${allowed} allowed, within limit of ${limit} under 50-way contention`);
    else fail(`${allowed} allowed — exceeds limit ${limit}!`);
    await flushPrefix(redis, prefix);
    await redis.quit();
    separator();
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

export async function run() {
  await raceMemoryStore();
  await raceRedisStore();
  await raceHighConcurrency();
}

if (import.meta.main) {
  await run();
}
