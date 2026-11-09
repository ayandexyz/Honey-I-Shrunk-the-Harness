// =============================================================================
// Hook Payload - the JSON document an external hook receives
// Command hooks read it on stdin; http hooks receive it as the request body.
// Field names follow Claude Code's hook input, so a tool written for Claude
// Code's hooks reads FreeCode's unchanged. Events Claude Code does not have
// pass their own fields, snake_cased.
// =============================================================================

import type { HookContext, HookEventName, ToolCallInput } from "./types.js";

export type HookPayload = Record<string, unknown>;

const TOOL_EVENTS: ReadonlySet<HookEventName> = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
]);

export function buildHookPayload(
  event: HookEventName,
  input: ToolCallInput,
  context: HookContext,
): HookPayload {
  const payload: HookPayload = {
    session_id: context.sessionId,
    hook_event_name: event,
    cwd: typeof context.cwd === "string" ? context.cwd : process.cwd(),
  };
  if (typeof context.agentId === "string") payload.agent_id = context.agentId;
  if (typeof context.agentType === "string")
    payload.agent_type = context.agentType;

  const fields = input.toolInput ?? {};

  if (TOOL_EVENTS.has(event)) {
    payload.tool_name = input.toolName;
    payload.tool_input = fields;
    if (typeof context.toolUseId === "string")
      payload.tool_use_id = context.toolUseId;
    if (event === "PostToolUse" && input.result !== undefined)
      payload.tool_response = input.result;
    if (event === "PostToolUseFailure" && input.result !== undefined)
      payload.error = input.result;
    return payload;
  }

  switch (event) {
    case "UserPromptSubmit":
      payload.prompt = fields.prompt;
      return payload;
    case "Notification":
      payload.message = fields.message;
      if (typeof fields.notificationType === "string")
        payload.notification_type = fields.notificationType;
      return payload;
    case "SessionStart":
      payload.source = typeof fields.source === "string" ? fields.source : "startup";
      return payload;
    case "SessionEnd":
      payload.reason = fields.reason;
      return payload;
    case "Stop":
      payload.stop_hook_active = false;
      return payload;
  }

  for (const [key, value] of Object.entries(fields)) {
    payload[snakeCase(key)] = value;
  }
  return payload;
}

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
