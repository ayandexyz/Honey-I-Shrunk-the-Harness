// =============================================================================
// A turn core starts on its own keeps the session's agent mode. Regression:
// session.sendSystemReminder (jcode's retry after a transient model error)
// passed no agentMode, AgentLoop defaulted it to "build", and a danger session
// started asking permission for every compound bash call after its first 5xx
// (sessions 50f4745d / 181c471a: ~18 minutes each waiting on prompts).
// Real server handlers + AgentLoop, fake provider, HOME in a temp dir.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freecode-agent-mode-home-"));
process.env.HOME = home;

const { registerProvider } = await import("./providers/registry.js");
const { bus, rejectPermission } = await import("./bus/index.js");
const { methodHandlers } = await import("./server.js");

const info = {
  id: "mode-fake",
  name: "mode-fake",
  defaultModel: "m",
  supportsStreaming: true,
  supportsTools: true,
};
let calls = 0;

registerProvider("mode-fake" as never, {
  info,
  create: () => ({
    info,
    execute: async () => {
      throw new Error("not used");
    },
    stream: async function* () {
      // First call: a compound bash command — build mode asks for it.
      if (calls++ % 2 === 0) {
        yield { type: "tool_call", id: `c${calls}`, name: "bash", args: { command: "echo a; echo b" } };
      } else {
        yield { type: "text_delta", delta: "done" };
      }
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  }),
} as never);

test.after(() => rmSync(home, { recursive: true, force: true }));

test("a hidden system-reminder turn runs in the session's danger mode", async () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-agent-mode-project-"));
  const asked: string[] = [];
  const unsubscribe = bus.subscribe("permission.asked", (event) => {
    asked.push((event as { toolName: string }).toolName);
    // Answer at once so a regression fails the assertion, not a 30-min wait.
    rejectPermission((event as { requestId: string }).requestId);
  });
  try {
    const { sessionId } = (await methodHandlers["session.start"]!({
      projectPath: project,
      provider: "mode-fake",
      model: "m",
      agentMode: "danger",
    })) as { sessionId: string };

    await methodHandlers["session.sendSystemReminder"]!({
      sessionId,
      reminder: "[auto] The previous model request failed; continue.",
    });

    assert.deepEqual(asked, [], "danger mode must never ask");
  } finally {
    unsubscribe();
    rmSync(project, { recursive: true, force: true });
  }
});

// The desktop reloads history with a bare `session.resume` (no agentMode)
// whenever its cache is empty (freecode_session.rs `history`). That used to
// reset a live danger session to build, so the next turn core started itself
// asked permission again.
test("a resume with no mode keeps the live session's danger mode", async () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-agent-mode-project-"));
  const asked: string[] = [];
  const unsubscribe = bus.subscribe("permission.asked", (event) => {
    asked.push((event as { toolName: string }).toolName);
    rejectPermission((event as { requestId: string }).requestId);
  });
  try {
    const { sessionId } = (await methodHandlers["session.start"]!({
      projectPath: project,
      provider: "mode-fake",
      model: "m",
      agentMode: "danger",
    })) as { sessionId: string };
    // A first turn persists the session so resume can load it.
    await methodHandlers["session.sendSystemReminder"]!({ sessionId, reminder: "go" });

    await methodHandlers["session.resume"]!({ sessionId });
    await methodHandlers["session.sendSystemReminder"]!({
      sessionId,
      reminder: "[auto] The previous model request failed; continue.",
    });

    assert.deepEqual(asked, [], "danger mode must survive a bare resume");
  } finally {
    unsubscribe();
    rmSync(project, { recursive: true, force: true });
  }
});
