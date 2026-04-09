/**
 * Memory growth benchmark: measures heap usage under different scenarios.
 * Tests maxKeys eviction effectiveness and memory stability.
 *
 * Run: bun run benchmark/memory-growth.ts
 */
import { MemoryStore } from "../core/adapters/memory-store";
import type { AlgorithmConfig } from "../core/types";
import {
  fail,
  fmt,
  fmtBytes,
  fmtMs,
  header,
  metric,
  pass,
  separator,
  subheader,
  warn,
} from "./helpers";

function getHeapUsed(): number {
  return process.memoryUsage().heapUsed;
}

// ─── Unbounded growth test ──────────────────────────────────────────────────

async function unboundedGrowth() {
  header("Memory Growth: Unbounded MemoryStore (no maxKeys)");

  const counts = [1_000, 10_000, 50_000, 100_000];

  for (const count of counts) {
    Bun.gc(true);
    const heapBefore = getHeapUsed();
    const store = new MemoryStore(0);

    for (let i = 0; i < count; i++) {
      store.set(`key-${i}`, { count: 1, windowStart: Date.now() }, 60_000);
    }

    const heapAfter = getHeapUsed();
    const growth = heapAfter - heapBefore;

    subheader(`${fmt(count)} unique keys`);
    metric("store size", fmt(store.size));
    metric("heap before", fmtBytes(heapBefore));
    metric("heap after", fmtBytes(heapAfter));
    metric("growth", fmtBytes(growth), `~${fmtBytes(Math.round(growth / count))}/key`);
    separator();

    store.dispose();
  }
}

// ─── maxKeys capped growth ──────────────────────────────────────────────────

async function cappedGrowth() {
  header("Memory Growth: MemoryStore with maxKeys=10,000");

  const maxKeys = 10_000;
  const totalInserts = 100_000;

  Bun.gc(true);
  const heapBefore = getHeapUsed();
  const store = new MemoryStore({ cleanupIntervalMs: 0, maxKeys });

  const t0 = performance.now();
  for (let i = 0; i < totalInserts; i++) {
    store.set(`key-${i}`, { count: 1, windowStart: Date.now() }, 60_000);
  }
  const elapsed = performance.now() - t0;

  const heapAfter = getHeapUsed();
  const growth = heapAfter - heapBefore;

  subheader(`${fmt(totalInserts)} inserts, maxKeys=${fmt(maxKeys)}`);
  metric("store size", fmt(store.size));
  metric("insert time", fmtMs(elapsed));
  metric("ops/sec", fmt((totalInserts / elapsed) * 1000));
  metric("heap growth", fmtBytes(growth));

  if (store.size <= maxKeys) pass(`Store capped at ${fmt(store.size)} keys`);
  else fail(`Store has ${fmt(store.size)} keys, exceeds maxKeys=${fmt(maxKeys)}`);
  separator();

  store.dispose();
}

// ─── Comparison: unbounded vs capped under same load ────────────────────────

async function compareGrowth() {
  header("Memory Comparison: Unbounded vs maxKeys=5000 (50K inserts)");

  const totalInserts = 50_000;

  // Unbounded
  Bun.gc(true);
  const heap1Before = getHeapUsed();
  const unbounded = new MemoryStore(0);
  for (let i = 0; i < totalInserts; i++) {
    unbounded.set(`key-${i}`, { count: 1, ts: Date.now() }, 60_000);
  }
  const heap1After = getHeapUsed();
  const unboundedGrowth = heap1After - heap1Before;
  unbounded.dispose();

  // Capped
  Bun.gc(true);
  const heap2Before = getHeapUsed();
  const capped = new MemoryStore({ cleanupIntervalMs: 0, maxKeys: 5_000 });
  for (let i = 0; i < totalInserts; i++) {
    capped.set(`key-${i}`, { count: 1, ts: Date.now() }, 60_000);
  }
  const heap2After = getHeapUsed();
  const cappedGrowthBytes = heap2After - heap2Before;
  capped.dispose();

  subheader("unbounded");
  metric("keys stored", fmt(totalInserts));
  metric("heap growth", fmtBytes(unboundedGrowth));

  subheader("maxKeys=5000");
  metric("keys stored", "5,000");
  metric("heap growth", fmtBytes(cappedGrowthBytes));

  if (cappedGrowthBytes < unboundedGrowth) {
    const saved = unboundedGrowth - cappedGrowthBytes;
    pass(`maxKeys saved ${fmtBytes(saved)} of memory (${((saved / unboundedGrowth) * 100).toFixed(0)}% reduction)`);
  } else {
    warn("Capped store used more memory than unbounded (GC timing variance)");
  }
  separator();
}

// ─── Algorithm state size comparison ────────────────────────────────────────

async function algorithmStateSize() {
  header("State Size Per Algorithm (10,000 keys each)");

  const count = 10_000;
  const algorithms: { name: string; config: AlgorithmConfig }[] = [
    {
      name: "token-bucket",
      config: { algorithm: "token-bucket", capacity: 100, refillRate: 10 },
    },
    {
      name: "fixed-window",
      config: { algorithm: "fixed-window", limit: 100, windowMs: 60_000 },
    },
    {
      name: "sliding-window (O(1) counter)",
      config: { algorithm: "sliding-window", limit: 100, windowMs: 60_000 },
    },
  ];

  for (const { name, config } of algorithms) {
    const store = new MemoryStore(0);

    Bun.gc(true);
    const heapBefore = getHeapUsed();

    for (let i = 0; i < count; i++) {
      store.check(`key-${i}`, config, Date.now(), 60_000);
    }

    const heapAfter = getHeapUsed();
    const growth = heapAfter - heapBefore;

    // Get a sample state for size measurement
    store.check("sample", config, Date.now(), 60_000);
    const sampleState = store.get("sample");
    const stateJson = JSON.stringify(sampleState);

    subheader(name);
    metric("keys", fmt(count));
    metric("heap growth", fmtBytes(growth), `~${fmtBytes(Math.round(growth / count))}/key`);
    metric("sample state", `${stateJson.length} bytes JSON`, stateJson);
    separator();

    store.dispose();
  }
}

// ─── TTL eviction effectiveness ─────────────────────────────────────────────

async function ttlEviction() {
  header("TTL Eviction: Expired entries cleanup");

  const store = new MemoryStore({ cleanupIntervalMs: 50 });

  // Insert 1000 keys with 100ms TTL
  for (let i = 0; i < 1000; i++) {
    store.set(`expire-${i}`, { v: i }, 100);
  }
  metric("keys before", fmt(store.size));

  // Wait for TTL + cleanup interval
  await Bun.sleep(200);

  metric("keys after 200ms", fmt(store.size));

  if (store.size === 0) pass("All expired entries evicted");
  else if (store.size < 100) pass(`Most entries evicted (${store.size} remaining)`);
  else warn(`${store.size} entries remain after TTL`);

  store.dispose();
  separator();
}

// ─── Run ─────────────────────────────────────────────────────────────────────

export async function run() {
  await unboundedGrowth();
  await cappedGrowth();
  await compareGrowth();
  await algorithmStateSize();
  await ttlEviction();
}

if (import.meta.main) {
  await run();
}
