#!/usr/bin/env bun
/**
 * Benchmark runner — runs all or specific benchmark suites.
 *
 * Usage:
 *   bun run bench              # run all benchmarks
 *   bun run bench:throughput   # only throughput
 *   bun run bench:race         # only race condition
 *   bun run bench:burst        # only burst
 *   bun run bench:memory       # only memory growth
 *
 * Or directly:
 *   bun run benchmark/run.ts [suite...]
 *   bun run benchmark/run.ts throughput race
 */

import { run as runBurst } from "./burst";
import { run as runMemory } from "./memory-growth";
import { run as runRace } from "./race-condition";
import { run as runThroughput } from "./throughput";

const suites: Record<string, { name: string; run: () => Promise<void> }> = {
  throughput: { name: "Throughput", run: runThroughput },
  race: { name: "Race Condition", run: runRace },
  burst: { name: "Burst", run: runBurst },
  memory: { name: "Memory Growth", run: runMemory },
};

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  dim: "\x1b[2m",
};

function printBanner() {
  console.log(
    `\n${c.bold}${c.cyan}` +
      `  ╔══════════════════════════════════════════════╗\n` +
      `  ║   Rate Limiter Benchmark Suite               ║\n` +
      `  ╚══════════════════════════════════════════════╝${c.reset}\n`
  );
}

async function main() {
  printBanner();

  const args = process.argv.slice(2);
  const requested =
    args.length > 0
      ? args.filter((a) => a in suites)
      : Object.keys(suites);

  if (requested.length === 0) {
    console.log(`Available suites: ${Object.keys(suites).join(", ")}`);
    console.log(`Usage: bun run benchmark/run.ts [suite...]`);
    process.exit(1);
  }

  console.log(
    `${c.dim}  Running: ${requested.join(", ")}${c.reset}\n`
  );

  const totalStart = performance.now();

  for (const key of requested) {
    const suite = suites[key]!;
    const start = performance.now();
    await suite.run();
    const elapsed = performance.now() - start;
    console.log(
      `  ${c.green}✓${c.reset} ${suite.name} completed in ${(elapsed / 1000).toFixed(1)}s\n`
    );
  }

  const totalMs = performance.now() - totalStart;
  console.log(
    `${c.bold}${c.green}  All benchmarks completed in ${(totalMs / 1000).toFixed(1)}s${c.reset}\n`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
