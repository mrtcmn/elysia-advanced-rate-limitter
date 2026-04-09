import Redis from "ioredis";
import type { RedisClient } from "../core/adapters/redis-store";
import type { AlgorithmConfig, RateLimitResult, RateLimitStore, StoredState } from "../core/types";

// ─── Colors ──────────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
};

// ─── Formatting ──────────────────────────────────────────────────────────────

export function fmt(n: number, decimals = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ─── Reporting ───────────────────────────────────────────────────────────────

export function header(title: string): void {
  const line = "─".repeat(60);
  console.log(`\n${c.cyan}${line}${c.reset}`);
  console.log(`${c.bold}${c.cyan}  ${title}${c.reset}`);
  console.log(`${c.cyan}${line}${c.reset}\n`);
}

export function subheader(title: string): void {
  console.log(`  ${c.bold}${c.white}${title}${c.reset}`);
}

export function metric(label: string, value: string, note = ""): void {
  const pad = label.padEnd(24);
  const noteStr = note ? `  ${c.dim}${note}${c.reset}` : "";
  console.log(
    `    ${c.dim}${pad}${c.reset}${c.bold}${value}${c.reset}${noteStr}`
  );
}

export function pass(msg: string): void {
  console.log(`    ${c.green}✓${c.reset} ${msg}`);
}

export function fail(msg: string): void {
  console.log(`    ${c.red}✗${c.reset} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`    ${c.yellow}⚠${c.reset} ${msg}`);
}

export function separator(): void {
  console.log();
}

// ─── Timing ──────────────────────────────────────────────────────────────────

export interface BenchResult {
  totalMs: number;
  ops: number;
  opsPerSec: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
}

export function computeStats(
  latencies: number[]
): Omit<BenchResult, "totalMs" | "ops" | "opsPerSec"> {
  const sorted = latencies.slice().sort((a, b) => a - b);
  const len = sorted.length;
  return {
    avgMs: sorted.reduce((a, b) => a + b, 0) / len,
    p50Ms: sorted[Math.floor(len * 0.5)]!,
    p95Ms: sorted[Math.floor(len * 0.95)]!,
    p99Ms: sorted[Math.floor(len * 0.99)]!,
    minMs: sorted[0]!,
    maxMs: sorted[len - 1]!,
  };
}

export async function bench(
  name: string,
  ops: number,
  fn: (i: number) => void | Promise<void>
): Promise<BenchResult> {
  const latencies: number[] = [];

  // warmup
  for (let i = 0; i < Math.min(50, ops); i++) {
    await fn(i);
  }

  const start = performance.now();
  for (let i = 0; i < ops; i++) {
    const t0 = performance.now();
    await fn(i);
    latencies.push(performance.now() - t0);
  }
  const totalMs = performance.now() - start;

  const stats = computeStats(latencies);
  const opsPerSec = (ops / totalMs) * 1000;

  return { totalMs, ops, opsPerSec, ...stats };
}

export function printBenchResult(name: string, r: BenchResult): void {
  subheader(name);
  metric(
    "ops/sec",
    fmt(r.opsPerSec),
    `${fmt(r.ops)} ops in ${fmtMs(r.totalMs)}`
  );
  metric("avg", fmtMs(r.avgMs));
  metric("p50", fmtMs(r.p50Ms));
  metric("p95", fmtMs(r.p95Ms));
  metric("p99", fmtMs(r.p99Ms));
  metric("min / max", `${fmtMs(r.minMs)} / ${fmtMs(r.maxMs)}`);
  separator();
}

// ─── Concurrent runner ───────────────────────────────────────────────────────

export async function concurrentBench(
  name: string,
  concurrency: number,
  opsPerWorker: number,
  fn: (workerId: number, opIndex: number) => void | Promise<void>
): Promise<BenchResult & { concurrency: number }> {
  const latencies: number[] = [];
  const totalOps = concurrency * opsPerWorker;

  const start = performance.now();
  const workers = Array.from({ length: concurrency }, async (_, workerId) => {
    for (let i = 0; i < opsPerWorker; i++) {
      const t0 = performance.now();
      await fn(workerId, i);
      latencies.push(performance.now() - t0);
    }
  });
  await Promise.all(workers);
  const totalMs = performance.now() - start;

  const stats = computeStats(latencies);
  const opsPerSec = (totalOps / totalMs) * 1000;

  return { totalMs, ops: totalOps, opsPerSec, ...stats, concurrency };
}

// ─── Real Redis connection ───────────────────────────────────────────────────

export function createRedisClient(): Redis {
  return new Redis({
    host: process.env.REDIS_HOST!,
    port: Number(process.env.REDIS_PORT!),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
}

/** Flush all keys matching a prefix (cleanup between benchmarks) */
export async function flushPrefix(redis: Redis, prefix: string): Promise<void> {
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

// ─── Failing store for circuit breaker benchmarks ────────────────────────────

export function createFailingStore(errorRate: number): RateLimitStore {
  return {
    async get() {
      if (Math.random() < errorRate) throw new Error("random failure");
      return null;
    },
    async set() {
      if (Math.random() < errorRate) throw new Error("random failure");
    },
    async check(
      _key: string,
      _config: AlgorithmConfig,
      _nowMs: number,
      _ttlMs: number
    ): Promise<RateLimitResult> {
      if (Math.random() < errorRate) throw new Error("random failure");
      return { allowed: true, limit: 0, remaining: 0, resetMs: 0, retryAfterMs: 0 };
    },
  };
}
