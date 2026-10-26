// =============================================================================
// Trace cost — includes foreground turns and every recorded auxiliary call.
// =============================================================================

import { totalUsd } from "../providers/pricing.js";
import type { CacheWarmSpan, MemoryAuxiliarySpan, Trace } from "./trace.js";

const UNPRICEABLE = "__unresolved_memory_model__";

/**
 * True when an auxiliary call reported no token usage at all — every failed
 * call, and any success whose provider omitted usage. A failed request may
 * still have been billed (a timeout after the provider started generating), so
 * "no usage" means unknown, never zero.
 */
export function auxiliaryUsageUnavailable(span: MemoryAuxiliarySpan): boolean {
  return span.inputTokens === undefined && span.outputTokens === undefined;
}

function cacheWarmUsageUnavailable(span: CacheWarmSpan): boolean {
  return span.inputTokens === undefined && span.outputTokens === undefined;
}

/**
 * Prices every provider call a trace records. An auxiliary event can lack its
 * resolved model (older logs and failed calls) or its usage; retain it as an
 * unpriceable placeholder so a partial total remains visibly partial instead
 * of silently omitting that call or pricing it at $0.
 */
export function traceCost(trace: Trace) {
  const cacheWarmSpans = trace.cacheWarmSpans ?? [];
  return totalUsd([
    ...trace.modelSpans,
    ...trace.auxiliarySpans.map((span) => ({
      ...span,
      model:
        span.model === undefined || auxiliaryUsageUnavailable(span)
          ? UNPRICEABLE
          : span.model,
    })),
    ...cacheWarmSpans.map((span) => ({
      ...span,
      model: cacheWarmUsageUnavailable(span) ? UNPRICEABLE : span.model,
    })),
  ]);
}

export type CostOperation =
  | "agent"
  | "cache_warm"
  | MemoryAuxiliarySpan["purpose"];

/**
 * The same bill as `traceCost`, split by what spent it: foreground agent turns
 * and each memory operation. Operations with no calls are omitted; one whose
 * calls are all unpriceable is present as `undefined`, so "did not run" and
 * "ran at an unknown price" stay distinct.
 */
export function traceCostByOperation(
  trace: Trace,
): Partial<
  Record<CostOperation, { usd: number; partial: boolean } | undefined>
> {
  const out: Partial<
    Record<CostOperation, { usd: number; partial: boolean } | undefined>
  > = {};
  if (trace.modelSpans.length > 0) out.agent = totalUsd(trace.modelSpans);
  const byPurpose = new Map<CostOperation, MemoryAuxiliarySpan[]>();
  for (const span of trace.auxiliarySpans) {
    const list = byPurpose.get(span.purpose) ?? [];
    list.push(span);
    byPurpose.set(span.purpose, list);
  }
  for (const [purpose, spans] of byPurpose) {
    out[purpose] = traceCost({
      ...trace,
      modelSpans: [],
      auxiliarySpans: spans,
      cacheWarmSpans: [],
    });
  }
  const cacheWarmSpans = trace.cacheWarmSpans ?? [];
  if (cacheWarmSpans.length > 0) {
    out.cache_warm = totalUsd(
      cacheWarmSpans.map((span) => ({
        ...span,
        model: cacheWarmUsageUnavailable(span) ? UNPRICEABLE : span.model,
      })),
    );
  }
  return out;
}
