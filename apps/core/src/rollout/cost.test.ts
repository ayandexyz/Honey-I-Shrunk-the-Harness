import test from "node:test";
import assert from "node:assert/strict";
import { buildTrace } from "./trace.js";
import { traceCost, traceCostByOperation } from "./cost.js";
import { renderTrace } from "./trace-render.js";
import type { RolloutEvent } from "./types.js";

let seq = 0;
function event(
  type: RolloutEvent["type"],
  timestamp: number,
  fields: Record<string, unknown>,
): RolloutEvent {
  seq++;
  return {
    type,
    id: `id-${seq}`,
    seq,
    aggregateID: "s1",
    timestamp,
    ...fields,
  } as RolloutEvent;
}

// claude-sonnet-4-5 is $3/Mtok input, so 1M input tokens is exactly $3.
function aux(
  purpose: string,
  outcome: "succeeded" | "failed",
  usage: Record<string, number> = { inputTokens: 1_000_000, outputTokens: 0 },
) {
  return event("memory.auxiliary", 5000, {
    turnId: "turn-0",
    purpose,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    duration_ms: 100,
    outcome,
    ...usage,
  });
}

test("a failed memory call makes the total partial, never free", () => {
  // A timed-out call can still have been billed. Pricing its missing usage as
  // zero tokens would report it as a free call and the total as complete.
  const trace = buildTrace("s1", [
    aux("extraction", "succeeded"),
    aux("retrieval_judge", "failed", {}),
  ]);
  const cost = traceCost(trace);
  assert.equal(cost?.usd, 3);
  assert.equal(cost?.partial, true);
});

test("a success that reported no usage is unknown, not zero", () => {
  const trace = buildTrace("s1", [aux("extraction", "succeeded", {})]);
  assert.equal(traceCost(trace), undefined);
});

test("fully reported memory calls price as a complete total", () => {
  const trace = buildTrace("s1", [
    aux("extraction", "succeeded"),
    aux("consolidation", "succeeded"),
  ]);
  assert.deepEqual(traceCost(trace), { usd: 6, partial: false });
});

test("cache warming is included once and split from runtime agent cost", () => {
  const trace = buildTrace("s1", [
    event("cache.warm", 5000, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      phase: "idle",
      delayMs: 1,
      expectedSavingsUsd: 1,
      warmCostUsd: 0.3,
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      outcome: "succeeded",
    }),
  ]);
  assert.deepEqual(traceCost(trace), { usd: 0.3, partial: false });
  assert.deepEqual(traceCostByOperation(trace).cache_warm, {
    usd: 0.3,
    partial: false,
  });
});

test("the per-operation split sums to the whole and keeps unknowns visible", () => {
  const trace = buildTrace("s1", [
    aux("retrieval_judge", "succeeded"),
    aux("extraction", "succeeded"),
    aux("consolidation", "failed", {}),
  ]);
  const split = traceCostByOperation(trace);
  assert.deepEqual(split.retrieval_judge, { usd: 3, partial: false });
  assert.deepEqual(split.extraction, { usd: 3, partial: false });
  assert.ok("consolidation" in split, "ran, so present");
  assert.equal(split.consolidation, undefined, "ran at an unknown price");
  assert.ok(!("final_flush" in split), "did not run, so absent");
  assert.ok(!("agent" in split), "no foreground turns");

  const rendered = renderTrace(trace);
  assert.match(rendered, /by op .*retrieval_judge=\$3\.00/);
  assert.match(rendered, /consolidation=unpriced/);
  assert.match(rendered, /1 auxiliary call\(s\) reported no usage/);
});
