// =============================================================================
// SessionEnd Hooks - Run once when a session ends, whatever ended it
// =============================================================================

import type { HookContext } from "./types.js";
import { getHooksForEvent } from "./registry.js";
import { executeHooks } from "./executors/index.js";

/**
 * Claude Code's reason vocabulary. "clear" means another session takes over
 * the same process — a supervisor should not read it as the agent exiting.
 */
export type SessionEndHookReason = "clear" | "other";

export async function runSessionEndHooks(
  reason: SessionEndHookReason,
  context: HookContext,
): Promise<void> {
  const hooks = getHooksForEvent("SessionEnd");
  if (hooks.length === 0) {
    return;
  }

  await executeHooks(
    hooks,
    { toolName: "SessionEnd", toolInput: { reason } },
    context,
  );
}
