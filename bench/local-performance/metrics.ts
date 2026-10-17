import { performance } from "node:perf_hooks";

export type BenchmarkLayer = "backend" | "frontend" | "provider" | "end_to_end";

export interface Distribution {
  min: number;
  p50: number;
  p75: number;
  p95: number;
  max: number;
}

export interface BenchmarkResult {
  name: string;
  layer: BenchmarkLayer;
  unit: "ms";
  samples: number;
  distribution: Distribution;
  work: Record<string, number | string>;
}

export interface SampleOptions {
  name: string;
  layer: BenchmarkLayer;
  iterations: number;
  warmup: number;
  work?: Record<string, number | string>;
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(1, fraction)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const weight = position - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export function summarize(values: number[]): Distribution {
  if (values.length === 0) {
    return { min: 0, p50: 0, p75: 0, p95: 0, max: 0 };
  }
  return {
    min: Math.min(...values),
    p50: percentile(values, 0.5),
    p75: percentile(values, 0.75),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

export function resultFromSamples(
  name: string,
  layer: BenchmarkLayer,
  values: number[],
  work: Record<string, number | string> = {},
): BenchmarkResult {
  return {
    name,
    layer,
    unit: "ms",
    samples: values.length,
    distribution: summarize(values),
    work,
  };
}

export async function sample(
  options: SampleOptions,
  run: (iteration: number) => void | Promise<void>,
): Promise<BenchmarkResult> {
  const values: number[] = [];
  const total = options.warmup + options.iterations;
  for (let i = 0; i < total; i++) {
    const started = performance.now();
    await run(i);
    const elapsed = performance.now() - started;
    if (i >= options.warmup) values.push(elapsed);
  }
  return resultFromSamples(options.name, options.layer, values, options.work);
}

export function roundMs(value: number): number {
  return Number(value.toFixed(3));
}
