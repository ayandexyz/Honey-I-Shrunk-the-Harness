// =============================================================================
// A case's scripted `answers` reply to the model's `question` calls, in order;
// once they run out the runner declines as before. Without them no case could
// observe what a model does with an ANSWER (TODO: session 2041efa4).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { registerProvider } from "../providers/registry.js";
import type { ProviderId } from "../providers/config.js";
import type { ExecuteOptions } from "../providers/types.js";

const info = {
  id: "answers-fake",
  name: "answers-fake",
  defaultModel: "m",
  supportsStreaming: false,
  supportsTools: true,
  maxOutputTokens: 4096,
};

const ask = (id: string) => ({
  id,
  name: "question",
  args: {
    questions: [
      {
        question: "Which scope?",
        options: [
          { label: "Just exploring", description: "" },
          { label: "Build it", description: "" },
        ],
      },
    ],
  },
});

test("scripted answers reply first, then questions are declined", async () => {
  const { runTrial } = await import("./runner.js");

  let calls = 0;
  /** The latest tool result the model saw, per call. */
  const seen: string[] = [];
  registerProvider("answers-fake" as ProviderId, {
    info,
    create: () =>
      ({
        info,
        execute: async (opts: ExecuteOptions) => {
          const n = ++calls;
          const parts = (opts.messages.at(-1)?.parts ?? []) as Array<{ result?: unknown }>;
          seen.push(String(parts.find((p) => p.result !== undefined)?.result ?? ""));
          const base = {
            provider: "answers-fake",
            model: "m",
            usage: { inputTokens: 10, outputTokens: 1 },
          };
          if (n <= 2) {
            return { ...base, content: "", toolCalls: [ask(`q${n}`)], stopReason: "tool_use" };
          }
          return { ...base, content: "done", stopReason: "stop" };
        },
      }) as never,
  });

  const result = await runTrial(
    {
      id: "answers",
      prompt: "help me",
      expectTool: "question",
      answers: ["Just exploring"],
    } as never,
    { provider: "answers-fake", model: "m", projectPath: process.cwd() },
  );

  assert.equal(calls, 3);
  assert.match(seen[1], /Just exploring/, "the first question got the scripted answer");
  assert.doesNotMatch(seen[2], /Just exploring/);
  assert.match(seen[2], /rejected/, "the second was declined");
  assert.equal(result.questionsRejected, 1);
});
