import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskCostLedger } from "./cost-ledger.js";
import type { RolloutEvent } from "./types.js";

let seq = 0;
function event(
  aggregateID: string,
  type: RolloutEvent["type"],
  timestamp: number,
  fields: Record<string, unknown>,
): RolloutEvent {
  seq += 1;
  return {
    id: `event-${seq}`,
    seq,
    aggregateID,
    type,
    timestamp,
    ...fields,
  } as RolloutEvent;
}

function request(sessionId: string, turnId: string, timestamp: number) {
  return event(sessionId, "model.request", timestamp, {
    turnId,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    messageCount: 1,
    toolCount: 1,
    promptChars: 10,
    streamed: true,
  });
}

function response(sessionId: string, turnId: string, timestamp: number) {
  return event(sessionId, "model.response", timestamp, {
    turnId,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    duration_ms: 100,
    inputTokens: 1_000_000,
    outputTokens: 0,
    toolCalls: [],
    textChars: 0,
    thinkingChars: 0,
  });
}

test("reconciles root, child, compaction, memory, and cache attempts once", () => {
  const root = "root";
  const child = "verifier-1";
  const sessions = new Map<string, RolloutEvent[]>([
    [
      root,
      [
        request(root, "turn-0", 100),
        response(root, "turn-0", 200),
        event(root, "subagent.start", 250, {
          subagentId: child,
          task: "verify",
          agentType: "verifier",
        }),
        event(root, "memory.auxiliary", 300, {
          purpose: "extraction",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          duration_ms: 50,
          outcome: "succeeded",
          inputTokens: 1_000_000,
          outputTokens: 0,
        }),
        event(root, "memory.auxiliary", 400, {
          purpose: "compaction",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          duration_ms: 50,
          outcome: "succeeded",
          inputTokens: 1_000_000,
          outputTokens: 0,
        }),
        event(root, "cache.warm", 500, {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          phase: "idle",
          delayMs: 1000,
          expectedSavingsUsd: 1,
          warmCostUsd: 0.3,
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 0,
          authMode: "api-key",
        }),
      ],
    ],
    [child, [request(child, "turn-0", 600), response(child, "turn-0", 700)]],
  ]);

  const ledger = buildTaskCostLedger(root, sessions);
  assert.equal(ledger.runtimeAttempts.length, 5);
  assert.deepEqual(
    ledger.runtimeAttempts.map((attempt) => attempt.purpose),
    ["agent", "extraction", "compaction", "cache_warm", "verifier"],
  );
  assert.equal(ledger.runtime.attempts, 5);
  assert.equal(ledger.runtime.inputTokens, 5_000_000);
  assert.equal(ledger.runtime.partial, false);
  assert.equal(ledger.runtime.usd, 12.3);
  assert.equal(ledger.grader.attempts, 0);
  assert.equal(ledger.byPurpose.verifier?.usd, 3);
  assert.equal(ledger.missingChildSessionIds.length, 0);
  assert.ok(
    ledger.runtimeAttempts.every(
      (attempt) => attempt.pricingVintage.length > 0,
    ),
  );
});

test("keeps failed and missing-usage attempts visible and the total partial", () => {
  const sessions = new Map<string, RolloutEvent[]>([
    [
      "root",
      [
        request("root", "turn-0", 100),
        event("root", "model.error", 200, {
          turnId: "turn-0",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          duration_ms: 100,
          kind: "provider",
          error: "failed",
        }),
      ],
    ],
  ]);
  const ledger = buildTaskCostLedger("root", sessions);
  assert.equal(ledger.runtimeAttempts[0]?.completion, "failed");
  assert.equal(ledger.runtimeAttempts[0]?.usageStatus, "unknown");
  assert.equal(ledger.runtime.usd, undefined);
  assert.equal(ledger.runtime.partial, true);
});
