// =============================================================================
// Coordinator — every external hook receives the document for the event it
// was registered under, whichever executor runs it.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { registerHook, unregisterAllHooks } from "../registry.js";
import { runPreToolUseHooks } from "../PreToolUse.js";
import { runStopHooks } from "../Stop.js";
import type { ToolCall } from "../../agent/types.js";

const toolCall: ToolCall = {
  id: "call-1",
  tool: "bash",
  args: { command: "ls" },
  execution: "sequential",
};

test("a command hook reads its own event's document on stdin", async () => {
  unregisterAllHooks("settings");
  registerHook("PreToolUse", "spy", {
    type: "command",
    command: `node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log(p.hook_event_name+" "+p.tool_name+" "+p.tool_use_id)})'`,
  });
  try {
    const result = await runPreToolUseHooks(toolCall, {
      sessionId: "s1",
      turnCount: 1,
      toolUseId: "call-1",
    });
    assert.equal(result.additionalContext, "PreToolUse bash call-1");
  } finally {
    unregisterAllHooks("settings");
  }
});

test("an http hook receives its event's document", async () => {
  unregisterAllHooks("settings");
  let body = "";
  const server = createServer((req, res) => {
    req.on("data", (d) => (body += d));
    req.on("end", () => res.end("{}"));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  registerHook("Stop", "board", {
    type: "http",
    url: `http://127.0.0.1:${port}/hooks/s1`,
  });
  try {
    await runStopHooks("done", { sessionId: "s1", turnCount: 1, cwd: "/repo" });
    const payload = JSON.parse(body);
    assert.equal(payload.hook_event_name, "Stop");
    assert.equal(payload.session_id, "s1");
    assert.equal(payload.cwd, "/repo");
  } finally {
    unregisterAllHooks("settings");
    server.close();
  }
});
