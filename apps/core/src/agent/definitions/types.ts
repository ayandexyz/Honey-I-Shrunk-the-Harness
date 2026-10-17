// =============================================================================
// Agent definition — a named role the `agent` tool can spawn (`subagent_type`).
// =============================================================================

import type { PermissionOperation } from "../../tools/tool.types.js";

export type AgentDefinitionScope =
  | "builtin"
  | "claude-code-user"
  | "user"
  | "claude-code-project"
  | "project";

/**
 * A definition's capability ceiling (spec `2026-09-27-agent-control-and-definitions.md`
 * §5.3). Closed: an operation it does not name is denied, whatever the mode or
 * the permission rules would allow. Not enforced yet — see the spec's §5 phase list.
 */
export interface AgentEnvelope {
  operations: PermissionOperation[];
  read?: string[];
  write?: string[];
  network?: boolean;
  shell?: boolean;
  grants?: string[];
}

export interface AgentDefinition {
  name: string;
  /** One line: when to use it. Listed to the model in the system prompt. */
  description: string;
  /** The role's instructions; added to the subagent's system prompt. Empty = none. */
  prompt: string;
  /**
   * Allowlist of FreeCode tool names. Intersected with what the subagent's
   * mode allows, so it can narrow the set but never widen it. Undefined = the
   * mode's full set.
   */
  tools?: string[];
  /** `provider/model` to run on; undefined inherits the parent's. */
  model?: string;
  /** explore = read-only; build = may write, inheriting the parent's mode. */
  mode: "explore" | "build";
  scope: AgentDefinitionScope;
  /** File it came from; absent for built-ins. */
  location?: string;
  /** Capability ceiling, when the file declares one. Undefined = no key, unchanged. */
  envelope?: AgentEnvelope;
}

/** What a spawned subagent's loop needs from its definition. */
export interface AgentRole {
  name: string;
  prompt: string;
  tools?: string[];
}
