// =============================================================================
// Permission Evaluation - The decision function for a tool call
// Order: envelope ceiling → danger bypass → mode enforcement → deny → ask →
// allow → mode default. Deny is absolute; session grants live in the allow tier
// and never beat deny. The envelope outranks every tier, `danger` included: an
// agent's own declared ceiling is not a policy a mode can widen.
// Spec: docs/specs/2026-07-18-permission-rules.md §2, §5
//       docs/specs/2026-09-27-agent-control-and-definitions.md §5.4
// =============================================================================

import type { AgentEnvelope } from "../agent/definitions/types.js";
import type { AgentMode } from "../agent/types.js";
import type { PermissionOperation } from "../tools/tool.types.js";
import type { PermissionEvaluation, PermissionRuleSet } from "./rule-types.js";
import { findMatch } from "./rules.js";
import { envelopeDecision, resolveEnvelopeTarget } from "./envelope.js";
import { modeAllowsAsk, modeDefault, modeEnforcement } from "./mode-policy.js";

export interface EvaluateInput {
  toolName: string;
  args: Record<string, unknown>;
  mode: AgentMode;
  rules: PermissionRuleSet;
  projectRoot: string;
  /** The running agent's effective ceiling, when its definition declares one. */
  envelope?: AgentEnvelope;
  /** The tool's declared `permissions.operations`; `[]` when it declares none. */
  operations?: readonly PermissionOperation[];
  /**
   * Whether this build can sandbox a shell. Only the loop, which probes the
   * machine, supplies it; omitted everywhere else (spec §5.5).
   */
  sandboxAvailable?: boolean;
}

export function evaluatePermission(input: EvaluateInput): PermissionEvaluation {
  const { toolName, args, mode, rules, projectRoot } = input;

  // 0. The agent's own envelope, above everything — including `danger`.
  if (input.envelope) {
    const { kind, target } = resolveEnvelopeTarget(toolName, args, projectRoot);
    const verdict = envelopeDecision({
      envelope: input.envelope,
      toolName,
      operations: input.operations ?? [],
      kind,
      ...(target === undefined ? {} : { target }),
      projectRoot,
      ...(input.sandboxAvailable === undefined
        ? {}
        : { sandboxAvailable: input.sandboxAvailable }),
    });
    if (verdict.decision === "deny") {
      return { decision: "deny", source: "envelope", reason: verdict.reason };
    }
  }

  // 1. Danger mode bypasses everything — rules, hooks, prompts
  if (mode === "danger") {
    return { decision: "allow", source: "danger" };
  }

  // 2. Mode-level enforcement (plan/review/explore read-only) beats allow rules
  const enforced = modeEnforcement(mode, toolName);
  if (enforced !== undefined) {
    return { decision: "deny", source: "mode-enforced", matchedRule: enforced };
  }

  // 3. Rule tiers in strict precedence: deny > ask > allow
  const denyHit = findMatch(rules.deny, toolName, args, projectRoot);
  if (denyHit) {
    return { decision: "deny", source: "rule", matchedRule: denyHit.raw };
  }
  const askHit = findMatch(rules.ask, toolName, args, projectRoot);
  if (askHit) {
    if (!modeAllowsAsk(mode)) {
      return { decision: "deny", source: "mode-enforced", matchedRule: askHit.raw };
    }
    return { decision: "ask", source: "rule", matchedRule: askHit.raw };
  }
  const allowHit = findMatch(rules.allow, toolName, args, projectRoot);
  if (allowHit) {
    return { decision: "allow", source: "rule", matchedRule: allowHit.raw };
  }

  // 4. No rule matched — fall through to the mode default
  const fallback = modeDefault(mode, toolName, args, projectRoot);
  if (fallback === "ask" && !modeAllowsAsk(mode)) {
    return { decision: "deny", source: "mode-default" };
  }
  return { decision: fallback, source: "mode-default" };
}
