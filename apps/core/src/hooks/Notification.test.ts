// =============================================================================
// Notification hooks carry a type, as Claude Code's do, so a hook can tell a
// permission prompt from a question and a matcher can select either one.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { registerHook, unregisterAllHooks } from "./registry.js";
import { runNotificationHooks } from "./Notification.js";

const ctx = { sessionId: "s1", turnCount: 1 };

test("a notification carries its message and type", async () => {
  unregisterAllHooks("settings");
  const seen: Array<Record<string, unknown>> = [];
  registerHook("Notification", "spy", {
    type: "callback",
    callback: async (input) => {
      seen.push(input.toolInput);
      return { action: "continue" };
    },
  });
  try {
    await runNotificationHooks("Permission needed: bash", ctx, "permission_prompt");
    assert.deepEqual(seen, [
      { message: "Permission needed: bash", notificationType: "permission_prompt" },
    ]);
  } finally {
    unregisterAllHooks("settings");
  }
});

test("a matcher selects notifications by type", async () => {
  unregisterAllHooks("settings");
  const seen: string[] = [];
  registerHook(
    "Notification",
    "questions-only",
    {
      type: "callback",
      callback: async (input) => {
        seen.push(String(input.toolInput.message));
        return { action: "continue" };
      },
    },
    "settings",
    { matcher: "question" },
  );
  try {
    await runNotificationHooks("Permission needed: bash", ctx, "permission_prompt");
    await runNotificationHooks("Which approach?", ctx, "question");
    assert.deepEqual(seen, ["Which approach?"]);
  } finally {
    unregisterAllHooks("settings");
  }
});
