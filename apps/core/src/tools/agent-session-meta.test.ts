// =============================================================================
// agent: the spawned session records who spawned it and how it ended, so a
// frontend listing sessions (the desktop sidebar) can nest it under its parent.
// Real AgentLoop, fake provider, HOME in a temp dir.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freecode-agent-meta-home-"));
process.env.HOME = home;

const { registerProvider } = await import("../providers/registry.js");
const { tools } = await import("./index.js");
const { getAgentRegistry } = await import("../agent/registry/index.js");
const { createHookRuntime } = await import("../hooks/runtime.js");
const { createSessionStore } = await import("../session/store.js");

const info = {
  id: "meta-fake",
  name: "meta-fake",
  defaultModel: "fake-model",
  supportsStreaming: true,
  supportsTools: true,
};

registerProvider("meta-fake" as never, {
  info,
  create: () => ({
    info,
    execute: async () => ({
      content: "",
      stopReason: "stop",
      provider: "meta-fake",
      model: "fake-model",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    stream: async function* () {
      yield { type: "text", text: "Done." };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    },
  }),
} as never);

test.after(() => rmSync(home, { recursive: true, force: true }));

test("a finished subagent's session names its spawner and final status", async () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-agent-meta-project-"));
  try {
    const result = await tools.agent.execute(
      { task: "Count callers", prompt: "Count callers", agentType: "meta-fake" },
      {
        sessionId: "root-meta",
        cwd: project,
        projectPath: project,
        hooks: createHookRuntime(),
      } as never,
    );
    assert.equal(result.success, true);
    const id = result.success ? String(result.result.metadata?.subagentId) : "";

    const store = await createSessionStore(join(home, ".freecode"));
    const meta = await store.getMeta(id, project);
    assert.deepEqual(meta?.agent, {
      parentId: "root-meta",
      label: "general",
      status: "completed",
    });
  } finally {
    getAgentRegistry().disposeRoot("root-meta");
    rmSync(project, { recursive: true, force: true });
  }
});
