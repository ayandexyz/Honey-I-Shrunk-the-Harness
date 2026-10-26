// =============================================================================
// A finished trial must not leave anything pinning its AgentLoop. The trial
// backstop timer was never cleared, so for 5 minutes after every trial its
// closure held the whole conversation; a 190-trial `eval ab` OOM'd at 4GB.
// (The cache warmer did the same, permanently — disposed in cleanup now.)
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { registerProvider } from "../providers/registry.js";
import type { ProviderId } from "../providers/config.js";
import { runTrial } from "./runner.js";

const info = {
  id: "retention-fake",
  name: "retention-fake",
  defaultModel: "m",
  supportsStreaming: false,
  supportsTools: true,
  maxOutputTokens: 4096,
};

test("a finished trial leaves no trial-length timer pending", async () => {
  registerProvider("retention-fake" as ProviderId, {
    info,
    create: () =>
      ({
        info,
        execute: async () => ({
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          provider: "retention-fake",
          model: "m",
          usage: { inputTokens: 1000, outputTokens: 10 },
        }),
      }) as never,
  });

  const pending = new Set<unknown>();
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    const timer = realSet(() => {
      pending.delete(timer);
      fn();
    }, ms, ...rest);
    if ((ms ?? 0) >= 60_000) pending.add(timer);
    return timer;
  }) as typeof setTimeout;
  (globalThis as { clearTimeout: unknown }).clearTimeout = ((timer: unknown) => {
    pending.delete(timer);
    realClear(timer as Parameters<typeof clearTimeout>[0]);
  }) as typeof clearTimeout;

  try {
    await runTrial(
      { id: "retention", prompt: "say done", expectTool: null } as never,
      { provider: "retention-fake", model: "m", projectPath: process.cwd() },
    );
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
  assert.equal(pending.size, 0, "a long timer outlived its trial");
});
