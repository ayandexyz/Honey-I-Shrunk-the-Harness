// =============================================================================
// Hook Output - interpret what a successful hook said
// Shared by command hooks (stdout on exit 0) and http hooks (a 2xx body).
// Both FreeCode's own JSON and Claude Code's hook output are understood, so a
// hook written for either agent means the same thing here.
// =============================================================================

import type { HookExecutionResult } from "./types.js";

type Decision = "allow" | "deny" | "ask";

interface RawOutput {
  // FreeCode
  block?: boolean;
  reason?: string;
  modifiedInput?: Record<string, unknown>;
  modifiedOutput?: unknown;
  context?: string;
  permissionDecision?: unknown;
  // Claude Code
  continue?: boolean;
  stopReason?: string;
  decision?: unknown;
  hookSpecificOutput?: {
    permissionDecision?: unknown;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
    decision?: unknown;
  };
}

export function parseHookOutput(text: string): HookExecutionResult {
  const trimmed = text.trim();
  if (trimmed === "") return { success: true };

  const raw = parseObject(trimmed);
  if (!raw) return { success: true, additionalContext: trimmed };

  if (raw.block === true || raw.decision === "block") {
    return { success: false, blocked: true, blockReason: raw.reason };
  }
  if (raw.continue === false) {
    return {
      success: false,
      blocked: true,
      blockReason: raw.stopReason ?? raw.reason,
    };
  }

  const specific = raw.hookSpecificOutput ?? {};
  if (specific.permissionDecision === "deny") {
    return {
      success: false,
      blocked: true,
      blockReason: specific.permissionDecisionReason ?? raw.reason,
    };
  }

  const nested = readNestedDecision(specific.decision);
  const permissionDecision =
    nested.decision ??
    asDecision(specific.permissionDecision) ??
    asDecision(raw.permissionDecision);
  const modifiedInput =
    nested.updatedInput ?? specific.updatedInput ?? raw.modifiedInput;
  const additionalContext =
    raw.context ?? specific.additionalContext ?? nested.message;

  const result: HookExecutionResult = { success: true };
  if (modifiedInput !== undefined) result.modifiedInput = modifiedInput;
  if (raw.modifiedOutput !== undefined) result.modifiedOutput = raw.modifiedOutput;
  if (additionalContext !== undefined) result.additionalContext = additionalContext;
  if (permissionDecision !== undefined)
    result.permissionDecision = permissionDecision;
  return result;
}

function parseObject(text: string): RawOutput | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RawOutput)
      : undefined;
  } catch {
    return undefined;
  }
}

function asDecision(value: unknown): Decision | undefined {
  return value === "allow" || value === "deny" || value === "ask"
    ? value
    : undefined;
}

// Claude Code nests a PermissionRequest decision under `behavior`; a bare
// string is accepted as well.
function readNestedDecision(value: unknown): {
  decision?: Decision;
  updatedInput?: Record<string, unknown>;
  message?: string;
} {
  if (typeof value === "string") return { decision: asDecision(value) };
  if (!value || typeof value !== "object") return {};
  const v = value as {
    behavior?: unknown;
    updatedInput?: Record<string, unknown>;
    message?: string;
  };
  return {
    decision: asDecision(v.behavior),
    updatedInput: v.updatedInput,
    message: typeof v.message === "string" ? v.message : undefined,
  };
}
