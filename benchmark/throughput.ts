/**
 * Throughput benchmark: ops/sec for each algorithm × store combination.
 * Uses real Redis for Redis benchmarks.
 *
 * Run: bun run bench:throughput
 */
import { MemoryStore } from "../core/adapters/memory-store";
import { RedisStore } from "../core/adapters/redis-store";
import { fixedWindow } from "../core/algorithms/fixed-window";
import { slidingWindow } from "../core/algorithms/sliding-window";
import { tokenBucket } from "../core/algorithms/token-bucket";
import type { AlgorithmConfig, AlgorithmFn } from "../core/types";
import {
  bench,
  concurrentBench,
  createRedisClient,
  flushPrefix,
  fmt,
  fmtMs,
  header,
  metric,
  printBenchResult,
  separator,
  subheader,
} from "./helpers";

const OPS = 50_000;
const REDIS_OPS = 200; // fewer for real network I/O

const algorithms: {
  name: string;
  fn: AlgorithmFn;
  config: AlgorithmConfig;
}[] = [
  {
    name: "token-bucket",
    fn: tokenBucket as AlgorithmFn,
    config: { algorithm: "token-bucket", capacity: 100, refillRate: 10 },
  },
  {
    name: "fixed-window",
    fn: fixedWindow as AlgorithmFn,
    config: { algorithm: "fixed-window", limit: 100, windowMs: 60_000 },
  },
  {
    name: "sliding-window",
    fn: slidingWindow as AlgorithmFn,
    config: { algorithm: "sliding-window", limit: 100, windowMs: 60_000 },
  },
];

// ─── Pure Algorithm Throughput (no store) ────────────────────────────────────

async function benchAlgorithms() {
  header("Pure Algorithm Throughput (no store, no I/O)");

  for (const { name, fn, config } of algorithms) {
    let state: import("../core/types").StoredState | null = null;
    const result = await bench(`${name}`, OPS, () => {
      const { state: s } = fn(config, state, Date.now());
      state = s;
    });
    printBenchResult(name, result);
  }
}

// ─── MemoryStore Throughput ──────────────────────────────────────────────────

async function benchMemoryStore() {
  header("MemoryStore Throughput (check per algorithm)");

  for (const { name, config } of algorithms) {
    const store = new MemoryStore(0);
    const result = await bench(`memory + ${name}`, OPS, () => {
      store.check("bench-key", config, Date.now(), 60_000);
    });
    printBenchResult(`memory + ${name}`, result);
    store.dispose();
  }
}

// ─── Real Redis Throughput ──────────────────────────────────────────────────

async function benchRedisStore() {
  header("RedisStore Sequential Throughput (real Redis, single client)");

  const redis = createRedisClient();
  await redis.connect();

  for (const { name, config } of algorithms) {
    const prefix = `bench:tp:${name}:`;
    await flushPrefix(redis, prefix);

    const store = new RedisStore(redis as any, prefix);
    const result = await bench(
      `redis + ${name}`,
      REDIS_OPS,
      async () => {
        await store.check("bench-key", config, Date.now(), 60_000);
      }
    );
    printBenchResult(`redis + ${name}`, result);
    await flushPrefix(redis, prefix);
  }

  await redis.quit();
}

// ─── Concurrent Redis Throughput ─────────────────────────────────────────────

async function benchRedisConcurrent() {
  header("RedisStore Concurrent Throughput (real Redis, parallel requests)");

  const redis = createRedisClient();
  await redis.connect();

  const concurrencyLevels = [1, 10, 50, 100];

  for (const { name, config } of algorithms) {
    subheader(name);

    for (const concurrency of concurrencyLevels) {
      const prefix = `bench:conc:${name}:${concurrency}:`;
      await flushPrefix(redis, prefix);

      const store = new RedisStore(redis as any, prefix);
      const opsPerWorker = Math.ceil(200 / concurrency);

      const result = await concurrentBench(
        `${name} (c=${concurrency})`,
        concurrency,
        opsPerWorker,
        async (workerId) => {
          const key = `client-${workerId}`;
          await store.check(key, config, Date.now(), 60_000);
        }
      );

      metric(
        `c=${String(concurrency).padEnd(4)}`,
        `${fmt(result.opsPerSec)} ops/sec`,
        `p50=${fmtMs(result.p50Ms)}  p99=${fmtMs(result.p99Ms)}  total=${fmtMs(result.totalMs)}`
      );
      await flushPrefix(redis, prefix);
    }
    separator();
  }

  await redis.quit();
}

// ─── Multi-key throughput ───────────────────────────────────────────────────

async function benchMultiKey() {
  header("Multi-Key Throughput (1000 unique keys)");

  // Memory
  for (const { name, config } of algorithms) {
    const store = new MemoryStore(0);
    const result = await bench(`memory + ${name} (1K keys)`, OPS, (i) => {
      const key = `client-${i % 1000}`;
      store.check(key, config, Date.now(), 60_000);
    });
    printBenchResult(`memory + ${name} (1K keys)`, result);
    store.dispose();
  }

  // Redis
  const redis = createRedisClient();
  await redis.connect();

  for (const { name, config } of algorithms) {
    const prefix = `bench:mk:${name}:`;
    await flushPrefix(redis, prefix);

    const store = new RedisStore(redis as any, prefix);
    const result = await bench(
      `redis + ${name} (1K keys)`,
      REDIS_OPS,
      async (i) => {
        const key = `client-${i % 1000}`;
        await store.check(key, config, Date.now(), 60_000);
      }
    );
    printBenchResult(`redis + ${name} (1K keys)`, result);
    await flushPrefix(redis, prefix);
  }

  await redis.quit();
}

// ─── Run ─────────────────────────────────────────────────────────────────────

export async function run() {
  await benchAlgorithms();
  await benchMemoryStore();
  await benchRedisStore();
  await benchRedisConcurrent();
  await benchMultiKey();
}

if (import.meta.main) {
  await run();
}
