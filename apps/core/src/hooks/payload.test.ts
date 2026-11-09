// =============================================================================
// Hook payload — the JSON document every external hook receives. Its field
// names are Claude Code's, so a tool written against Claude Code's hooks reads
// FreeCode's without an adapter.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { buildHookPayload } from "./payload.js";
import type { HookContext } from "./types.js";

const ctx: HookContext = { sessionId: "s1", turnCount: 2, cwd: "/repo" };

test("every payload names its session, event and cwd", () => {
  const p = buildHookPayload("Stop", { toolName: "Stop", toolInput: {} }, ctx);
  assert.equal(p.session_id, "s1");
  assert.equal(p.hook_event_name, "Stop");
  assert.equal(p.cwd, "/repo");
});

test("tool events carry tool_name, tool_input and tool_use_id", () => {
  for (const event of ["PreToolUse", "PermissionRequest"] as const) {
    const p = buildHookPayload(
      event,
      { toolName: "bash", toolInput: { command: "ls" } },
      { ...ctx, toolUseId: "call-7" },
    );
    assert.equal(p.tool_name, "bash");
    assert.deepEqual(p.tool_input, { command: "ls" });
    assert.equal(p.tool_use_id, "call-7");
  }
});

test("PostToolUse carries the tool's output as tool_response", () => {
  const p = buildHookPayload(
    "PostToolUse",
    { toolName: "bash", toolInput: { command: "ls" }, result: "a.txt" },
    ctx,
  );
  assert.equal(p.tool_response, "a.txt");
});

test("UserPromptSubmit carries the prompt", () => {
  const p = buildHookPayload(
    "UserPromptSubmit",
    { toolName: "UserPromptSubmit", toolInput: { prompt: "fix it", promptLength: 6 } },
    ctx,
  );
  assert.equal(p.prompt, "fix it");
});

test("Notification carries message and notification_type", () => {
  const p = buildHookPayload(
    "Notification",
    {
      toolName: "permission_prompt",
      toolInput: { message: "Permission needed: bash", notificationType: "permission_prompt" },
    },
    ctx,
  );
  assert.equal(p.message, "Permission needed: bash");
  assert.equal(p.notification_type, "permission_prompt");
});

test("SessionStart and SessionEnd carry source and reason", () => {
  const start = buildHookPayload(
    "SessionStart",
    { toolName: "SessionStart", toolInput: { source: "resume" } },
    ctx,
  );
  assert.equal(start.source, "resume");
  const fresh = buildHookPayload(
    "SessionStart",
    { toolName: "SessionStart", toolInput: {} },
    ctx,
  );
  assert.equal(fresh.source, "startup");
  const end = buildHookPayload(
    "SessionEnd",
    { toolName: "SessionEnd", toolInput: { reason: "other" } },
    ctx,
  );
  assert.equal(end.reason, "other");
});

test("Stop says it was not raised by a stop hook", () => {
  const p = buildHookPayload("Stop", { toolName: "Stop", toolInput: {} }, ctx);
  assert.equal(p.stop_hook_active, false);
});

test("events with no Claude Code counterpart pass their fields in snake_case", () => {
  const p = buildHookPayload(
    "TurnEnd",
    { toolName: "TurnEnd", toolInput: { turnCount: 3, inputTokens: 10 } },
    ctx,
  );
  assert.equal(p.turn_count, 3);
  assert.equal(p.input_tokens, 10);
});

test("subagent identity is included when present", () => {
  const p = buildHookPayload(
    "PreToolUse",
    { toolName: "read", toolInput: {} },
    { ...ctx, agentId: "a1", agentType: "explore" },
  );
  assert.equal(p.agent_id, "a1");
  assert.equal(p.agent_type, "explore");
});
