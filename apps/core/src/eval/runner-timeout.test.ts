// =============================================================================
// A trial that hits its timeout must STOP, not just be scored as failed. Losing
// the Promise.race left the agent loop running: one GLM trial kept calling the
// model for 3.5 minutes past its 300s budget, overlapping the next cases, and
// was reported as 0 tokens / 0 turns.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { registerProvider } from "../providers/registry.js";
import type { ProviderId } from "../providers/config.js";

const info = {
  id: "timeout-fake",
  name: "timeout-fake",
  defaultModel: "m",
  supportsStreaming: false,
  supportsTools: true,
  maxOutputTokens: 4096,
};

test("a timed-out trial stops its loop and reports what it spent", async () => {
  // Read once at module load; the floor is 1s. The budget includes trial
  // setup, so at 1s a loaded machine (full parallel suite: 14.9s for this
  // test) could spend it all before the first 100ms turn finished, and
  // `turns > 0` failed with nothing actually dropped. 5s leaves room for
  // turns to happen; the fake still never stops, so the timeout still ends it.
  process.env.FREECODE_EVAL_TRIAL_TIMEOUT_MS = "5000";
  const { runTrial } = await import("./runner.js");

  let calls = 0;
  registerProvider("timeout-fake" as ProviderId, {
    info,
    create: () =>
      ({
        info,
        // Never stops on its own: every turn asks for another (distinct) glob,
        // so only the timeout can end the trial.
        execute: async () => {
          const n = ++calls;
          await new Promise((r) => setTimeout(r, 100));
          return {
            content: "",
            toolCalls: [
              { id: `c${n}`, name: "glob", args: { pattern: `*.nope${n}` } },
            ],
            stopReason: "tool_use",
            provider: "timeout-fake",
            model: "m",
            usage: { inputTokens: 1000, outputTokens: 10 },
          };
        },
      }) as never,
  });

  const result = await runTrial(
    { id: "timeout", prompt: "loop forever", expectTool: null } as never,
    { provider: "timeout-fake", model: "m", projectPath: process.cwd() },
  );

  assert.equal(result.passed, false);
  assert.match(result.reason, /trial exceeded 5000ms/);
  assert.ok(result.turns > 0, "turns before the timeout were dropped");
  assert.ok(result.inputTokens > 0, "tokens before the timeout were dropped");

  const atReturn = calls;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(calls, atReturn, "the loop kept calling the model after the trial ended");
});
