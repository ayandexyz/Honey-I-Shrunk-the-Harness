#!/usr/bin/env tsx

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runFixtures } from "./fixtures.js";
import { roundMs, type BenchmarkResult } from "./metrics.js";

interface Report {
  schemaVersion: 1;
  generatedAt: string;
  environment: {
    node: string;
    platform: string;
    arch: string;
    iterations: number;
    warmup: number;
    networkCalls: 0;
  };
  results: BenchmarkResult[];
}

function integerFlag(argv: string[], name: string, fallback: number): number {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function stringFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function pad(value: string, width: number): string {
  return value.length > width
    ? `${value.slice(0, Math.max(0, width - 1))}…`
    : value.padEnd(width);
}

function delta(current: number, baseline?: number): string {
  if (baseline === undefined || baseline === 0) return "";
  const change = ((current - baseline) / baseline) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
}

function printReport(report: Report, baseline?: Report): void {
  const previous = new Map(
    baseline?.results.map((result) => [
      `${result.name}:${result.layer}`,
      result,
    ]),
  );
  process.stdout.write(
    `\nLocal performance harness — ${report.environment.iterations} samples ` +
      `(${report.environment.warmup} warmup), network calls: 0\n\n`,
  );
  process.stdout.write(
    `${pad("fixture", 37)} ${pad("layer", 11)} ${"p50".padStart(9)} ${"p75".padStart(9)} ${"p95".padStart(9)} ${"Δp95".padStart(9)}  work\n`,
  );
  process.stdout.write(`${"-".repeat(112)}\n`);
  for (const result of report.results) {
    const prior = previous.get(`${result.name}:${result.layer}`);
    const stats = result.distribution;
    process.stdout.write(
      `${pad(result.name, 37)} ${pad(result.layer, 11)} ` +
        `${roundMs(stats.p50).toFixed(3).padStart(9)} ` +
        `${roundMs(stats.p75).toFixed(3).padStart(9)} ` +
        `${roundMs(stats.p95).toFixed(3).padStart(9)} ` +
        `${delta(stats.p95, prior?.distribution.p95).padStart(9)}  ` +
        `${JSON.stringify(result.work)}\n`,
    );
  }
}

async function loadReport(
  path: string | undefined,
): Promise<Report | undefined> {
  if (!path) return undefined;
  return JSON.parse(await readFile(resolve(path), "utf8")) as Report;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const iterations = integerFlag(argv, "--iterations", 7);
  const warmup = integerFlag(argv, "--warmup", 2);
  const jsonOut = stringFlag(argv, "--json-out");
  const baseline = await loadReport(stringFlag(argv, "--compare"));
  const results = await runFixtures({
    iterations,
    warmup,
    repoRoot: resolve(process.cwd()),
  });
  const report: Report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      iterations,
      warmup,
      networkCalls: 0,
    },
    results,
  };

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printReport(report, baseline);
  }
  if (jsonOut) {
    await writeFile(resolve(jsonOut), `${JSON.stringify(report, null, 2)}\n`);
    if (!argv.includes("--json"))
      process.stdout.write(`\nWrote ${resolve(jsonOut)}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`local performance harness failed: ${String(error)}\n`);
  process.exitCode = 1;
});
