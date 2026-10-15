// =============================================================================
// PermissionRequest Hooks - Run before permission-gated operations
// =============================================================================

import type { ToolCall } from "../agent/types.js";
import type { ToolCallInput, HookContext } from "./types.js";
import { getMatchingHooks } from "./registry.js";
import { executeHooks } from "./executors/index.js";
import { bus } from "../bus/index.js";

/**
 * "passthrough" means either no PermissionRequest hook matched, or one did
 * match but gave no explicit `permissionDecision` — the caller should fall
 * back to the rules-engine decision (permission/evaluate.ts) either way.
 */
export type PermissionDecision = "allow" | "deny" | "ask" | "passthrough";

export interface PermissionRequestResult {
  decision: PermissionDecision;
  modifiedInput?: Record<string, unknown>;
  reason?: string;
}

// =============================================================================
// Run PermissionRequest hooks
// =============================================================================

export async function runPermissionRequestHooks(
  toolCall: ToolCall,
  context: HookContext,
): Promise<PermissionRequestResult> {
  const input: ToolCallInput = {
    toolName: toolCall.tool,
    toolInput: toolCall.args as Record<string, unknown>,
  };

  const matchingHooks = getMatchingHooks("PermissionRequest", input, context);

  if (matchingHooks.length === 0) {
    return { decision: "passthrough" }; // No hook matched: rules engine decides
  }

  const result = await executeHooks(matchingHooks, input, context);

  if (result.blocked) {
    bus.publish({
      type: "hook.blocked",
      hookName: "PermissionRequest",
      event: "PermissionRequest",
      sessionId: context.sessionId,
      reason: result.blockReason,
    } as any);

    return {
      decision: "deny",
      reason: result.blockReason,
    };
  }

  const reason = result.additionalContexts.join("\n") || undefined;

  if (result.permissionDecision === "deny") {
    return { decision: "deny", reason };
  }

  if (result.permissionDecision === "allow") {
    return { decision: "allow", modifiedInput: result.modifiedInput, reason };
  }

  // No explicit decision (undefined, or "ask"): the hook matched but has no
  // opinion — a bridge-style approver that timed out, or a hook whose only
  // job is to observe. Claude Code treats this the same way: silence is
  // neutral, never an implicit allow. Defer to the rules engine's own
  // ask/allow/deny (agent/loop.ts already handles "passthrough" from a
  // matched hook, not just from zero hooks matching).
  return { decision: "passthrough", modifiedInput: result.modifiedInput, reason };
}
