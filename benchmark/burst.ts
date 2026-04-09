/**
 * Burst benchmark: sudden traffic spikes hitting the rate limiter.
 * Tests with both MemoryStore and real Redis.
 *
 * Run: bun run bench:burst
 */
import { Elysia } from "elysia";
import { MemoryStore } from "../core/adapters/memory-store";
import { RedisStore } from "../core/adapters/redis-store";
import { ResilientStore } from "../core/adapters/resilient-store";
import type { AlgorithmConfig, RateLimitStore } from "../core/types";
import { rateLimiter } from "../plugin/elysia-plugin";
import {
  computeStats,
  createFailingStore,
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

function createTestApp(options: {
  algorithm: AlgorithmConfig;
  store?: RateLimitStore;
}) {
  return new Elysia()
    .use(
      rateLimiter({
        algorithm: options.algorithm,
        store: options.store,
      })
    )
    .get("/api", () => ({ ok: true }));
}

function makeRequest(ip: string): Request {
  return new Request("http://localhost/api", {
    headers: { "x-forwarded-for": ip },
  });
}

// ─── Sudden burst from single IP (MemoryStore) ─────────────────────────────

async function singleIpBurstMemory() {
  header("Burst: Single IP, 500 requests, MemoryStore");

  const configs: { name: string; algo: AlgorithmConfig; limit: number }[] = [
    {
      name: "token-bucket (cap=10)",
      algo: { algorithm: "token-bucket", capacity: 10, refillRate: 1 },
      limit: 10,
    },
    {
      name: "fixed-window (limit=10)",
      algo: { algorithm: "fixed-window", limit: 10, windowMs: 60_000 },
      limit: 10,
    },
    {
      name: "sliding-window (limit=10)",
      algo: { algorithm: "sliding-window", limit: 10, windowMs: 60_000 },
      limit: 10,
    },
  ];

  for (const { name, algo, limit } of configs) {
    subheader(name);

    const app = createTestApp({ algorithm: algo });
    const burstSize = 500;
    let allowed = 0;
    let denied = 0;
    const latencies: number[] = [];

    for (let i = 0; i < burstSize; i++) {
      const t0 = performance.now();
      const res = await app.handle(makeRequest("burst-ip"));
      latencies.push(performance.now() - t0);
      if (res.status === 200) allowed++;
      else denied++;
    }

    const stats = computeStats(latencies);
    metric("burst size", fmt(burstSize));
    metric("allowed", fmt(allowed));
    metric("denied (429)", fmt(denied));
    metric("avg latency", fmtMs(stats.avgMs));
    metric("p99 latency", fmtMs(stats.p99Ms));

    if (allowed <= limit + 1) pass(`Correctly capped at ~${limit} allowed`);
    else fail(`${allowed} allowed, expected ~${limit}`);
    separator();
  }
}

// ─── Burst with real Redis ──────────────────────────────────────────────────

async function singleIpBurstRedis() {
  header("Burst: Single IP, 200 requests, Real Redis");

  const redis = createRedisClient();
  await redis.connect();

  const configs: { name: string; algo: AlgorithmConfig; limit: number }[] = [
    {
      name: "redis + token-bucket (cap=20)",
      algo: { algorithm: "token-bucket", capacity: 20, refillRate: 1 },
      limit: 20,
    },
    {
      name: "redis + fixed-window (limit=20)",
      algo: { algorithm: "fixed-window", limit: 20, windowMs: 60_000 },
      limit: 20,
    },
    {
      name: "redis + sliding-window (limit=20)",
      algo: { algorithm: "sliding-window", limit: 20, windowMs: 60_000 },
      limit: 20,
    },
  ];

  for (const { name, algo, limit } of configs) {
    const prefix = `bench:burst:${algo.algorithm}:`;
    await flushPrefix(redis, prefix);

    const store = new RedisStore(redis as any, prefix);
    const app = createTestApp({ algorithm: algo, store });

    let allowed = 0;
    let denied = 0;
    const latencies: number[] = [];

    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      const res = await app.handle(makeRequest("redis-burst"));
      latencies.push(performance.now() - t0);
      if (res.status === 200) allowed++;
      else denied++;
    }

    const stats = computeStats(latencies);
    subheader(name);
    metric("allowed", fmt(allowed));
    metric("denied", fmt(denied));
    metric("avg latency", fmtMs(stats.avgMs));
    metric("p50 latency", fmtMs(stats.p50Ms));
    metric("p99 latency", fmtMs(stats.p99Ms));

    if (allowed <= limit + 1) pass(`Correctly capped at ~${limit} allowed`);
    else fail(`${allowed} allowed, expected ~${limit}`);
    await flushPrefix(redis, prefix);
    separator();
  }

  await redis.quit();
}

// ─── Multi-IP burst (DDoS-like) ────────────────────────────────────────────

async function multiIpBurst() {
  header("Burst: 100 unique IPs, 50 requests each (5000 total), MemoryStore");

  const app = createTestApp({
    algorithm: { algorithm: "fixed-window", limit: 5, windowMs: 60_000 },
  });

  const ips = 100;
  const reqPerIp = 50;
  let totalAllowed = 0;
  let totalDenied = 0;
  const latencies: number[] = [];

  const workers = Array.from({ length: ips }, async (_, ipIdx) => {
    const ip = `ddos-${ipIdx}`;
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < reqPerIp; i++) {
      const t0 = performance.now();
      const res = await app.handle(makeRequest(ip));
      latencies.push(performance.now() - t0);
      if (res.status === 200) allowed++;
      else denied++;
    }
    return { allowed, denied };
  });

  const results = await Promise.all(workers);
  for (const r of results) {
    totalAllowed += r.allowed;
    totalDenied += r.denied;
  }

  const stats = computeStats(latencies);
  subheader(`${ips} IPs × ${reqPerIp} reqs (limit=5 per IP)`);
  metric("total requests", fmt(ips * reqPerIp));
  metric("total allowed", fmt(totalAllowed), `expected ~${ips * 5}`);
  metric("total denied", fmt(totalDenied));
  metric("avg latency", fmtMs(stats.avgMs));
  metric("p95 latency", fmtMs(stats.p95Ms));
  metric("p99 latency", fmtMs(stats.p99Ms));

  const expectedAllowed = ips * 5;
  if (totalAllowed <= expectedAllowed + ips) pass(`Allowed within tolerance`);
  else fail(`${totalAllowed} allowed, expected ~${expectedAllowed}`);
  separator();
}

// ─── Burst with failing store + ResilientStore ──────────────────────────────

async function resilientBurst() {
  header("Burst: ResilientStore (50% error rate), fail-open behavior");

  const inner = createFailingStore(0.5);
  const resilient = new ResilientStore(inner);
  const app = createTestApp({
    algorithm: { algorithm: "token-bucket", capacity: 10, refillRate: 1 },
    store: resilient,
  });

  let status200 = 0;
  let status429 = 0;
  const latencies: number[] = [];

  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    const res = await app.handle(makeRequest("resilient-burst"));
    latencies.push(performance.now() - t0);
    if (res.status === 200) status200++;
    else if (res.status === 429) status429++;
  }

  const stats = computeStats(latencies);
  subheader("50% store failures -> fail-open");
  metric("200 responses", fmt(status200));
  metric("429 responses", fmt(status429));
  metric("avg latency", fmtMs(stats.avgMs));
  metric("p99 latency", fmtMs(stats.p99Ms));

  if (status200 > 100) pass(`Fail-open working: ${status200}/200 allowed`);
  else warn(`Only ${status200}/200 allowed`);
  separator();
}

// ─── Circuit breaker under burst ────────────────────────────────────────────

async function circuitBreakerBurst() {
  header(
    "Burst: Circuit Breaker (100% failures, threshold=3, cooldown=100ms)"
  );

  let innerCalls = 0;
  const brokenStore: RateLimitStore = {
    async get() {
      innerCalls++;
      throw new Error("down");
    },
    async set() {
      innerCalls++;
      throw new Error("down");
    },
    async check() {
      innerCalls++;
      throw new Error("down");
    },
  };

  const resilient = new ResilientStore(brokenStore, {
    threshold: 3,
    cooldownMs: 100,
  });
  const app = createTestApp({
    algorithm: { algorithm: "token-bucket", capacity: 10, refillRate: 1 },
    store: resilient,
  });

  const latencies: number[] = [];
  const burstSize = 500;

  for (let i = 0; i < burstSize; i++) {
    const t0 = performance.now();
    await app.handle(makeRequest("cb-burst"));
    latencies.push(performance.now() - t0);
  }

  const stats = computeStats(latencies);
  subheader("circuit breaker under 500-request burst");
  metric("inner store calls", fmt(innerCalls), `of ${burstSize} requests`);
  metric("calls saved", fmt(burstSize - innerCalls), "by circuit breaker");
  metric("avg latency", fmtMs(stats.avgMs));
  metric("p99 latency", fmtMs(stats.p99Ms));

  if (innerCalls < burstSize / 2)
    pass(
      `Circuit breaker saved ${burstSize - innerCalls} calls to broken store`
    );
  else
    warn(
      `Inner store called ${innerCalls} times — circuit breaker not effective`
    );
  separator();
}

// ─── Redis disconnection during burst ───────────────────────────────────────

async function redisDisconnectBurst() {
  header("Burst: Redis disconnect mid-burst (ResilientStore fail-open)");

  const redis = createRedisClient();
  await redis.connect();
  const prefix = "bench:burst:disconnect:";
  await flushPrefix(redis, prefix);

  const realStore = new RedisStore(redis as any, prefix, 500); // 500ms timeout
  const errors: unknown[] = [];
  const resilient = new ResilientStore(realStore, {
    onError: (e) => errors.push(e),
    threshold: 5,
    cooldownMs: 200,
  });

  const app = createTestApp({
    algorithm: { algorithm: "token-bucket", capacity: 20, refillRate: 5 },
    store: resilient,
  });

  let allowed = 0;
  let denied = 0;
  const latencies: number[] = [];

  // First 50 requests with healthy Redis
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    const res = await app.handle(makeRequest("disconnect-ip"));
    latencies.push(performance.now() - t0);
    if (res.status === 200) allowed++;
    else denied++;
  }

  subheader("phase 1: healthy Redis (50 requests)");
  metric("allowed", fmt(allowed));
  metric("denied", fmt(denied));
  metric("errors", fmt(errors.length));

  // Disconnect Redis
  await redis.disconnect();
  const phase1Errors = errors.length;

  // Next 50 requests with broken Redis
  let allowedP2 = 0;
  let deniedP2 = 0;
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    const res = await app.handle(makeRequest("disconnect-ip"));
    latencies.push(performance.now() - t0);
    if (res.status === 200) allowedP2++;
    else deniedP2++;
  }

  subheader("phase 2: Redis disconnected (50 requests)");
  metric("allowed", fmt(allowedP2));
  metric("denied", fmt(deniedP2));
  metric("new errors", fmt(errors.length - phase1Errors));

  if (allowedP2 > 0)
    pass(`Fail-open working: ${allowedP2} requests still served`);
  else fail("All requests failed after Redis disconnect");
  separator();
}

// ─── Run ─────────────────────────────────────────────────────────────────────

export async function run() {
  await singleIpBurstMemory();
  await singleIpBurstRedis();
  await multiIpBurst();
  await resilientBurst();
  await circuitBreakerBurst();
  await redisDisconnectBurst();
}

if (import.meta.main) {
  await run();
}
