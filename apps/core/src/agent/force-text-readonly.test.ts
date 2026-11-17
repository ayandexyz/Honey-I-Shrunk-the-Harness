// =============================================================================
// Signal B's force_text tier for read-only modes (plan/review/explore), as
// opposed to force-text.test.ts's build-mode case. Separate file because the
// trigger and threshold are different (readOnlyExplorationLimit, not 2x
// stagnantTurnsThreshold) — see effect/loop-health.ts and types.ts.
//
// The session that exposed this: `review` mode, asked to "fix a bug by
// editing", ran 21 turns of varied read/grep/glob/webfetch (never editing,
// correctly, since review forbids it) with ZERO loop-health signal — the
// stagnation counter used to not even advance in read-only modes at all.
// It was cut off only by the eval harness's own trial timeout, mid-
// generation, producing zero text.
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

test("a read-only mode run still gets forced to answer, instead of running away with no limit", async () => {
  const sessionId = "force-text-readonly-session";
  const provider = "force-text-readonly-fake";
  const tripAt = DEFAULT_LOOP_HEURISTICS.readOnlyExplorationLimit;
  const FINAL_TEXT = "This mode cannot edit the file; here is what I found instead.";

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
    const projectPath = mkdtempSync(join(tmpdir(), "freecode-force-text-readonly-test-"));
    const store = await runtime.runPromise(SessionStoreTag);
    await store.createSession({ title: "t", projectPath, provider }, sessionId);
    const loop = await runtime.runPromise(
      createAgentLoopEffect(sessionId, {
        maxIterations: tripAt + 10,
      }),
    );

    const result = await loop.run({
      prompt: "review this file and fix any bug by editing it",
      sessionId,
      provider,
      projectPath,
      agentMode: "review",
    });

    assert.equal(result.success, true);
    assert.match(result.content ?? "", /This mode cannot edit/);
    assert.doesNotMatch(result.content ?? "", /^Loop stopped/);

    const trippedIndex = calls.findIndex((c) => c.toolChoice === "none");
    assert.ok(
      trippedIndex >= 0,
      `expected the read-only run to eventually be forced text-only; got ${JSON.stringify(calls.map((c) => c.toolChoice))}`,
    );
    // It must not trip at the build-mode threshold (5) or its 2x (10) — only
    // at the read-only-specific limit (20).
    assert.ok(
      trippedIndex >= tripAt - 1,
      `tripped too early at turn ${trippedIndex}, before readOnlyExplorationLimit (${tripAt})`,
    );
    assert.equal(calls.length, trippedIndex + 1);
  } finally {
    await runtime.dispose();
  }
});
