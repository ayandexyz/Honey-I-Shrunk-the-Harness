// =============================================================================
// PermissionRequest passthrough — a matched hook with no explicit decision
// must never resolve to an implicit allow (Claude Code parity).
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { registerHook, unregisterAllHooks } from "./registry.js";
import { runPermissionRequestHooks } from "./PermissionRequest.js";
import type { ToolCall } from "../agent/types.js";

const ctx = { sessionId: "s1", turnCount: 1 };

const toolCall: ToolCall = {
  id: "c1",
  tool: "bash",
  args: { command: "rm -rf /tmp/x" },
  execution: "sequential",
};

test("no hook matched: passthrough", async () => {
  unregisterAllHooks("settings");
  const result = await runPermissionRequestHooks(toolCall, ctx);
  assert.equal(result.decision, "passthrough");
});

test("a matched hook that exits 0 with plain text (no JSON) is passthrough, not allow", async () => {
  unregisterAllHooks("settings");
  registerHook("PermissionRequest", "observer", {
    type: "command",
    command: "echo 'just observing'",
  });
  const result = await runPermissionRequestHooks(toolCall, ctx);
  assert.equal(result.decision, "passthrough");
  unregisterAllHooks("settings");
});

test("a matched hook that exits 0 with no opinion at all (callback, action: continue) is passthrough", async () => {
  unregisterAllHooks("settings");
  registerHook("PermissionRequest", "observer", {
    type: "callback",
    callback: async () => ({ action: "continue" }),
  });
  const result = await runPermissionRequestHooks(toolCall, ctx);
  assert.equal(result.decision, "passthrough");
  unregisterAllHooks("settings");
});

test('explicit {"permissionDecision":"allow"} is allow', async () => {
  unregisterAllHooks("settings");
  registerHook("PermissionRequest", "approver", {
    type: "command",
    command: `echo '{"permissionDecision":"allow"}'`,
  });
  const result = await runPermissionRequestHooks(toolCall, ctx);
  assert.equal(result.decision, "allow");
  unregisterAllHooks("settings");
});

test('explicit {"permissionDecision":"deny"} is deny, with its message', async () => {
  unregisterAllHooks("settings");
  registerHook("PermissionRequest", "denier", {
    type: "command",
    // Non-blocking output's message travels in "context" (like any other
    // hook event); "reason" is reserved for the hard-block (exit 2) path.
    command: `echo '{"permissionDecision":"deny","context":"no way"}'`,
  });
  const result = await runPermissionRequestHooks(toolCall, ctx);
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, "no way");
  unregisterAllHooks("settings");
});

test('{"permissionDecision":"ask"} is treated the same as no opinion: passthrough', async () => {
  unregisterAllHooks("settings");
  registerHook("PermissionRequest", "unsure", {
    type: "command",
    command: `echo '{"permissionDecision":"ask"}'`,
  });
  const result = await runPermissionRequestHooks(toolCall, ctx);
  assert.equal(result.decision, "passthrough");
  unregisterAllHooks("settings");
});

test("exit 2 (hard block) denies even if permissionDecision would say allow", async () => {
  unregisterAllHooks("settings");
  registerHook("PermissionRequest", "veto", {
    type: "command",
    command: `echo 'vetoed' >&2; exit 2`,
  });
  const result = await runPermissionRequestHooks(toolCall, ctx);
  assert.equal(result.decision, "deny");
  unregisterAllHooks("settings");
});
