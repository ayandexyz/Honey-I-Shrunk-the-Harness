// =============================================================================
// agent(): a sub-agent that runs into its iteration cap hands back the model's
// last words as a clean completion, so the tool has to say it is INCOMPLETE —
// `Status: SUCCESS` sent a parent straight on to review (session 7de8e317).
// Real AgentLoop, fake provider that never stops calling tools.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freecode-agent-cap-home-"));
process.env.HOME = home;

const { registerProvider } = await import("../providers/registry.js");
const { tools } = await import("./index.js");
const { getAgentRegistry } = await import("../agent/registry/index.js");
const { createHookRuntime } = await import("../hooks/runtime.js");

const info = { id: "cap-fake", name: "cap-fake", defaultModel: "m", supportsStreaming: true, supportsTools: true };
let calls = 0;
registerProvider("cap-fake" as never, {
  info,
  create: () => ({
    info,
    execute: async () => ({
      content: "",
      stopReason: "stop",
      provider: "cap-fake",
      model: "m",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    // A different glob every turn, so loop-health never sees a repeat.
    stream: async function* () {
      calls++;
      yield { type: "text", text: `still working (${calls})` };
      yield { type: "tool_call", id: `c${calls}`, name: "glob", args: { pattern: `*.none${calls}` } };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    },
  }),
} as never);

test.after(() => rmSync(home, { recursive: true, force: true }));

test("a sub-agent that hits its turn cap is reported INCOMPLETE, not SUCCESS", async () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-agent-cap-project-"));
  try {
    const result = await tools.agent.execute(
      { task: "Never finishes", prompt: "Keep searching", agentType: "cap-fake" },
      { sessionId: "root-cap", cwd: project, projectPath: project, hooks: createHookRuntime() } as never,
    );
    assert.equal(result.success, true);
    const output = result.success ? result.result.output : "";
    assert.match(output, /Status: INCOMPLETE \(hit its turn limit/);
    assert.doesNotMatch(output, /Status: SUCCESS/);
    assert.match(output, /iteration safety limit/, "no last text, but the note is not dropped");
  } finally {
    getAgentRegistry().disposeRoot("root-cap");
    rmSync(project, { recursive: true, force: true });
  }
});
