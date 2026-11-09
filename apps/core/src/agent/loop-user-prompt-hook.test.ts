// =============================================================================
// UserPromptSubmit fires once per user prompt, with that prompt — not once per
// model request with the system prompt. A hook can add context the model sees,
// rewrite the prompt, or block it before the model is ever called.
//
// Same rig as loop-steer.test.ts: real loop, fake provider.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestLayer } from "../effect/layers.js";
import { makeRuntime } from "../effect/runtime.js";
import { SessionStoreTag } from "../effect/context.js";
import { createAgentLoopEffect } from "./loop.js";
import { MemoryService } from "../compaction/service.js";
import { createRecorder } from "../rollout/recorder.js";
import { registerProvider } from "../providers/registry.js";
import type { ProviderId } from "../providers/config.js";
import type { AIProvider, ExecuteOptions, ExecuteResult, ProviderChunk } from "../providers/types.js";
import { registerHook, unregisterAllHooks } from "../hooks/registry.js";
import type { HookResult } from "../hooks/types.js";

const info = {
  id: "prompt-hook-fake",
  name: "prompt-hook-fake",
  defaultModel: "fake-model",
  supportsStreaming: true,
  supportsTools: true,
};

/** Every user message of every request, joined per request. */
const requests: string[][] = [];
let script: Array<"tool" | "text"> = [];

registerProvider("prompt-hook-fake" as ProviderId, {
  info,
  create: (): AIProvider => ({
    info,
    execute: async (): Promise<ExecuteResult> => ({
      content: "",
      stopReason: "stop",
      provider: "prompt-hook-fake",
      model: "fake-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    stream: async function* (opts: ExecuteOptions): AsyncGenerator<ProviderChunk> {
      const n = requests.length;
      requests.push(
        (opts.messages ?? [])
          .filter((m) => m.role === "user")
          .map((m) => m.parts.map((p) => (p.type === "text" ? p.content : "")).join("")),
      );
      if (script[n] === "tool") {
        yield { type: "tool_call", id: `call-${n}`, name: "glob", args: { pattern: "*.none" } };
      } else {
        yield { type: "text", text: "Done." };
      }
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    },
  }),
});

function onPrompt(callback: (prompt: string) => HookResult) {
  const seen: string[] = [];
  registerHook("UserPromptSubmit", "spy", {
    type: "callback",
    callback: async (input) => {
      const prompt = String(input.toolInput.prompt);
      seen.push(prompt);
      return callback(prompt);
    },
  });
  return seen;
}

async function runLoop(sessionId: string) {
  requests.length = 0;
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-prompt-hook-rollout-"));
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-prompt-hook-project-"));
  const runtime = makeRuntime(
    makeTestLayer({
      memoryFactory: {
        forSession: () =>
          new MemoryService(sessionId, {
            storage: {
              save: () => {},
              load: () => undefined,
              listSessions: () => [],
              delete: () => {},
            } as never,
          }),
      },
      recorderFactory: { forSession: (id: string) => createRecorder(id, { rolloutDir }) },
    }),
  );
  const store = await runtime.runPromise(SessionStoreTag);
  await store.createSession({ title: "t", projectPath, provider: "prompt-hook-fake" }, sessionId);
  const loop = await runtime.runPromise(createAgentLoopEffect(sessionId, { maxIterations: 10 }));
  try {
    const result = await loop.run({
      prompt: "Do the thing",
      sessionId,
      provider: "prompt-hook-fake",
      projectPath,
      agentMode: "explore",
    });
    const stored = await store.getMessages(sessionId, projectPath);
    return { result, stored };
  } finally {
    await runtime.dispose();
    rmSync(rolloutDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
    unregisterAllHooks("session");
    unregisterAllHooks("settings");
  }
}

test("UserPromptSubmit sees the user's prompt once, however many requests follow", async () => {
  script = ["tool", "text"];
  const seen = onPrompt(() => ({ action: "continue" }));
  await runLoop("prompt-once");
  assert.equal(requests.length, 2);
  assert.deepEqual(seen, ["Do the thing"]);
});

test("a hook's rewrite replaces the prompt the model sees", async () => {
  script = ["text"];
  onPrompt(() => ({ action: "modify", modifiedOutput: "Do the other thing" }));
  const { stored } = await runLoop("prompt-rewrite");
  assert.ok(requests[0]!.includes("Do the other thing"));
  assert.ok(!requests[0]!.includes("Do the thing"));
  assert.ok(stored.some((m) => m.role === "user" && JSON.stringify(m.parts).includes("Do the other thing")));
});

test("a blocking hook stops the prompt before the model is called", async () => {
  script = ["text"];
  onPrompt(() => ({ action: "block", reason: "secrets in prompt" }));
  const { result, stored } = await runLoop("prompt-blocked");
  assert.equal(requests.length, 0);
  assert.equal(result.success, false);
  assert.deepEqual(result.failure, { kind: "hook_blocked", reason: "secrets in prompt" });
  assert.ok(!stored.some((m) => JSON.stringify(m.parts).includes("Do the thing")));
});
