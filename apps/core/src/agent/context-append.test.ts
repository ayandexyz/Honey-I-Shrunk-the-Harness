// =============================================================================
// Append-only context through the real loop (agent/context-inject.ts): with
// FREECODE_APPEND_CONTEXT=1 the todo list reaches the model once, as a
// persisted message that stays where it was, and nothing rides as an ephemeral
// tail — so each request's messages are a prefix of the next one's, which is
// what lets a provider's prompt cache extend.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
import type { AIProvider, ExecuteOptions, ExecuteResult } from "../providers/types.js";
import type { Message } from "@freecode/shared";

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

type Seen = { messages: Message[]; tail?: string };

/** Turn 1 writes a todo list, turn 2 reads a file, turn 3 stops. */
function registerScripted(provider: string, file: string): Seen[] {
  const seen: Seen[] = [];
  const calls = [
    { name: "todowrite", args: { todos: [{ id: "1", content: "check the file", status: "in_progress" }] } },
    { name: "read", args: { filePath: file } },
  ];
  registerProvider(provider as ProviderId, {
    info: info(provider),
    create: (): AIProvider => ({
      info: info(provider),
      execute: async (opts: ExecuteOptions): Promise<ExecuteResult> => {
        seen.push({ messages: structuredClone(opts.messages ?? []), tail: opts.ephemeralTail });
        const call = calls[seen.length - 1];
        return call
          ? { content: "", toolCalls: [{ ...call, id: `c${seen.length}` }], stopReason: "tool_use", provider, model: "fake-model" }
          : { content: "done", toolCalls: [], stopReason: "stop", provider, model: "fake-model" };
      },
    }),
  });
  return seen;
}

async function run(sessionId: string, append: boolean): Promise<Seen[]> {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-ctx-append-"));
  const file = join(projectPath, "a.txt");
  writeFileSync(file, "hello\n");
  const seen = registerScripted(sessionId, file);
  const prev = process.env.FREECODE_APPEND_CONTEXT;
  process.env.FREECODE_APPEND_CONTEXT = append ? "1" : "0";
  const runtime = makeRuntime(
    makeTestLayer({
      memoryFactory: {
        forSession: () =>
          new MemoryService(sessionId, {
            storage: { save: () => {}, load: () => undefined, listSessions: () => [], delete: () => {} } as never,
          }),
      },
      recorderFactory: {
        forSession: (id: string) =>
          createRecorder(id, { rolloutDir: mkdtempSync(join(tmpdir(), "freecode-ctx-log-")) }),
      },
    }),
  );
  try {
    const store = await runtime.runPromise(SessionStoreTag);
    await store.createSession({ title: "t", projectPath, provider: sessionId }, sessionId);
    const loop = await runtime.runPromise(
      createAgentLoopEffect(sessionId, { maxIterations: 4, autoApproveAsks: true }),
    );
    await loop.run({ prompt: "go", sessionId, provider: sessionId, projectPath, agentMode: "build" });
  } finally {
    if (prev === undefined) delete process.env.FREECODE_APPEND_CONTEXT;
    else process.env.FREECODE_APPEND_CONTEXT = prev;
    await runtime.dispose();
  }
  return seen;
}

const text = (m: Message) =>
  m.parts.map((p) => (p.type === "text" ? p.content : "")).join("");

test("append mode: the todo list is appended once and every request extends the last", async () => {
  const seen = await run("ctx-append-on", true);
  // A 4th request is the auto-poke (the todo is left in_progress) — it too
  // must extend the previous request rather than rewrite it.
  assert.ok(seen.length >= 3);
  for (const s of seen) assert.ok(!s.tail, "no ephemeral tail in append mode");

  const listed = (s: Seen) => s.messages.filter((m) => m.role === "user" && text(m).includes("Current Task List"));
  assert.equal(listed(seen[0]).length, 0, "no list before todowrite");
  assert.equal(listed(seen[1]).length, 1, "the new list is delivered");
  for (const s of seen.slice(2)) {
    assert.equal(listed(s).length, 1, "an unchanged list is not delivered again");
  }

  for (let i = 1; i < seen.length; i++) {
    const before = seen[i - 1].messages;
    assert.deepEqual(seen[i].messages.slice(0, before.length), before, `request ${i} extends request ${i - 1}`);
  }
});

test("tail mode (default) still rides the list as a per-request tail", async () => {
  const seen = await run("ctx-append-off", false);
  assert.ok(seen[1].tail?.includes("Current Task List"));
  assert.ok(seen[2].tail?.includes("Current Task List"), "re-sent on every request");
});
