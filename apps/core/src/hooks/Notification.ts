// =============================================================================
// Notification Hooks - Run when the agent needs user attention
// =============================================================================

import type { HookContext } from "./types.js";
import { getMatchingHooks } from "./registry.js";
import { executeHooks } from "./executors/index.js";

// =============================================================================
// Run Notification hooks (e.g. permission approval needed, agent idle)
// =============================================================================

export async function runNotificationHooks(
  message: string,
  ctx: HookContext,
  notificationType?: string,
): Promise<void> {
  // The type stands in for the tool name, so a matcher selects notifications
  // by type the way Claude Code's Notification matchers do.
  const input = {
    toolName: notificationType ?? "Notification",
    toolInput: notificationType ? { message, notificationType } : { message },
  };

  const hooks = getMatchingHooks("Notification", input, ctx);
  if (hooks.length === 0) {
    return;
  }

  await executeHooks(hooks, input, ctx);
}
