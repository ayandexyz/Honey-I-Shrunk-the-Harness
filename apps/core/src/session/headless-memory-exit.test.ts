import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerProvider } from "../providers/registry.js";
import type { ProviderId } from "../providers/config.js";
import type { AIProvider, ProviderInfo } from "../providers/types.js";
import { flushSessionMemory } from "../memory/final-flush.js";
import { getMemoryStore } from "../memory/mem-store.js";
import { endSession, resetEndedSessions } from "./end-session.js";

const provider = "headless-flush-test" as ProviderId;
const info: ProviderInfo = {
  id: provider,
  name: provider,
  defaultModel: "test",
  supportsStreaming: false,
  supportsTools: false,
  maxOutputTokens: 1024,
};

registerProvider(provider, {
  info,
  create: (): AIProvider => ({
    info,
    execute: async () => ({
      content: JSON.stringify([
        {
          type: "user",
          name: "prefers-concise-replies",
          description: "Prefers concise replies",
          content: "The user prefers concise replies unless detail is requested.",
        },
      ]),
      stopReason: "stop",
      provider,
      model: "test",
    }),
    stream: async function* () {},
  }),
});

test("a short headless session persists its eligible final memory before exit", async () => {
  resetEndedSessions();
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-headless-memory-"));
  const store = getMemoryStore(projectPath);
  const sessionId = `headless-memory-${process.pid}-${Date.now()}`;
  const detail = "The user explicitly asks for concise replies. ".repeat(6);

  try {
    const result = await endSession(sessionId, {
      reason: "exit",
      memoryDrainTimeoutMs: 1_000,
      flush: () =>
        flushSessionMemory({
          sessionId,
          projectPath,
          provider,
          messages: [
            { role: "user", parts: [{ type: "text", content: detail }] },
            {
              role: "assistant",
              parts: [{ type: "text", content: "Understood; I will be concise." }],
            },
          ],
        }),
    });

    assert.deepEqual(result, {
      pendingMemoryJobs: 0,
      memoryDrainTimedOut: false,
    });
    assert.equal(
      store.load("prefers-concise-replies", "user")?.content,
      "The user prefers concise replies unless detail is requested.",
    );
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(dirname(store.getMemoryDir()), { recursive: true, force: true });
  }
});
