// =============================================================================
// Signal B's force_text tier (see effect/loop-health.ts, reminders.ts
// noProgressReminder): a run that goes 2x the stagnation threshold with no
// file change gets forced into a text-only reply instead of looping
// indefinitely or being cut off with a bare synthetic message. Same
// toolChoice: "none" mechanism as the iteration-cap safety valve
// (max-iterations.test.ts) — this file proves the OTHER trigger for it.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeTestLayer } from "../effect/layers.js";
import { makeRuntime } from "../effect/runtime.js";
import { SessionStoreTag } from "../effect/context.js";
import { createAgentLoopEffect } from "./loop.js";
import { registerProvider } from "../providers/registry.js";
import type { ProviderId } from "../providers/config.js";
import type { AIProvider, ExecuteResult, SystemBlock } from "../providers/types.js";
import { newlyDelivered } from "./context-inject.js";
import { DEFAULT_LOOP_HEURISTICS } from "./types.js";

function info(id: string) {
  return {
    id,
    name: id,
    defaultModel: "fake-model",
    supportsStreaming: false,
    supportsTools: true,
    maxOutputTokens: 4096,
  };
}

test("2x stagnation forces a text-only reply instead of looping indefinitely", async () => {
  const sessionId = "force-text-session";
  const provider = "force-text-fake";
  const threshold = DEFAULT_LOOP_HEURISTICS.stagnantTurnsThreshold;
  const tripAt = threshold * 2;
  const FINAL_TEXT = "Found three references; none point at a fix.";

  const calls: Array<{ system: SystemBlock[]; ephemeralTail?: string; toolChoice?: string }> = [];
  registerProvider(provider as ProviderId, {
    info: info(provider),
    create: (): AIProvider => ({
      info: info(provider),
      execute: async (opts): Promise<ExecuteResult> => {
        calls.push({
          system: Array.isArray(opts.system) ? opts.system : [],
          ephemeralTail: newlyDelivered(opts),
          toolChoice: opts.toolChoice,
        });
        // A varied, non-identical, non-mutating tool call every turn — the
        // exact pattern signal A (exact repetition) cannot see, since the
        // args differ each time.
        return {
          content: opts.toolChoice === "none" ? FINAL_TEXT : "",
          toolCalls:
            opts.toolChoice === "none"
              ? []
              : [{ name: "does-not-exist", args: { n: calls.length }, id: `c${calls.length}` }],
          stopReason: opts.toolChoice === "none" ? "stop" : "tool_use",
          provider,
          model: "fake-model",
        };
      },
    }),
  });

  const runtime = makeRuntime(makeTestLayer({}));
  try {
    const projectPath = mkdtempSync(join(tmpdir(), "freecode-force-text-test-"));
    const store = await runtime.runPromise(SessionStoreTag);
    await store.createSession({ title: "t", projectPath, provider }, sessionId);
    const loop = await runtime.runPromise(
      createAgentLoopEffect(sessionId, {
        // Well above tripAt, so stagnation — not the iteration cap — is
        // what ends this run.
        maxIterations: tripAt + 10,
      }),
    );

    const result = await loop.run({
      prompt: "find every reference to X and tell me what it affects",
      sessionId,
      provider,
      projectPath,
    });

    assert.equal(result.success, true);
    // The model's own answer survives — never a bare "Loop stopped" message
    // (that's what `stop` would have produced; force_text does not).
    assert.match(result.content ?? "", new RegExp(FINAL_TEXT.replace(/[.]/g, "\\.")));
    assert.doesNotMatch(result.content ?? "", /^Loop stopped/);

    // The run ends once a turn is forced text-only.
    const trippedIndex = calls.findIndex((c) => c.toolChoice === "none");
    assert.ok(trippedIndex >= 0, `expected some turn to be forced text-only; got ${JSON.stringify(calls.map((c) => c.toolChoice))}`);
    assert.match(calls[trippedIndex].ephemeralTail ?? "", /Do not call any more tools/);

    // No runaway: the run ends at the forced turn, not beyond it.
    assert.equal(calls.length, trippedIndex + 1);

    // Earlier turns were not forced.
    assert.equal(calls[0].toolChoice, undefined);
  } finally {
    await runtime.dispose();
  }
});
