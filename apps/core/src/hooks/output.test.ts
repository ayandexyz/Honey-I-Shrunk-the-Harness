// =============================================================================
// Hook output — what a hook that succeeded (exit 0, or http 2xx) said. Both
// FreeCode's own JSON and Claude Code's are understood, so a hook written for
// either agent behaves the same here.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { parseHookOutput } from "./output.js";

test("empty output is a plain continue", () => {
  assert.deepEqual(parseHookOutput(""), { success: true });
  assert.deepEqual(parseHookOutput("  \n"), { success: true });
});

test("plain text is additional context", () => {
  assert.deepEqual(parseHookOutput("lint ok\n"), {
    success: true,
    additionalContext: "lint ok",
  });
});

test("text that only looks like JSON is still context", () => {
  const r = parseHookOutput("{not json");
  assert.equal(r.success, true);
  assert.equal(r.additionalContext, "{not json");
});

test("FreeCode JSON is read as before", () => {
  const r = parseHookOutput(
    JSON.stringify({
      modifiedInput: { command: "rtk ls" },
      modifiedOutput: "x",
      context: "c",
      permissionDecision: "allow",
    }),
  );
  assert.deepEqual(r, {
    success: true,
    modifiedInput: { command: "rtk ls" },
    modifiedOutput: "x",
    additionalContext: "c",
    permissionDecision: "allow",
  });
});

test("FreeCode block wins", () => {
  const r = parseHookOutput(JSON.stringify({ block: true, reason: "no" }));
  assert.deepEqual(r, { success: false, blocked: true, blockReason: "no" });
});

test("Claude Code top-level decision block blocks", () => {
  const r = parseHookOutput(JSON.stringify({ decision: "block", reason: "dirty tree" }));
  assert.deepEqual(r, { success: false, blocked: true, blockReason: "dirty tree" });
});

test("Claude Code continue:false blocks with its stopReason", () => {
  const r = parseHookOutput(JSON.stringify({ continue: false, stopReason: "halt" }));
  assert.deepEqual(r, { success: false, blocked: true, blockReason: "halt" });
});

test("Claude Code PermissionRequest decision is nested under behavior", () => {
  const allow = parseHookOutput(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedInput: { command: "ls -la" } },
      },
    }),
  );
  assert.equal(allow.permissionDecision, "allow");
  assert.deepEqual(allow.modifiedInput, { command: "ls -la" });

  const deny = parseHookOutput(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "not on main" },
      },
    }),
  );
  assert.equal(deny.success, true);
  assert.equal(deny.permissionDecision, "deny");
  assert.equal(deny.additionalContext, "not on main");
});

test("a bare decision string is accepted too", () => {
  const r = parseHookOutput(
    JSON.stringify({ hookSpecificOutput: { decision: "deny" } }),
  );
  assert.equal(r.permissionDecision, "deny");
});

test("an unknown behavior is no decision at all", () => {
  const r = parseHookOutput(
    JSON.stringify({ hookSpecificOutput: { decision: { behavior: "maybe" } } }),
  );
  assert.equal(r.success, true);
  assert.equal(r.permissionDecision, undefined);
});

test("Claude Code PreToolUse deny blocks with its reason", () => {
  const r = parseHookOutput(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "rm is off limits",
      },
    }),
  );
  assert.deepEqual(r, {
    success: false,
    blocked: true,
    blockReason: "rm is off limits",
  });
});

test("Claude Code updatedInput and additionalContext are honoured", () => {
  const r = parseHookOutput(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { file_path: "b.ts" },
        additionalContext: "rewritten",
      },
    }),
  );
  assert.equal(r.success, true);
  assert.deepEqual(r.modifiedInput, { file_path: "b.ts" });
  assert.equal(r.additionalContext, "rewritten");
  assert.equal(r.permissionDecision, "allow");
});
