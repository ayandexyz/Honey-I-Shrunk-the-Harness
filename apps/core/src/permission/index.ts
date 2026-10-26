// =============================================================================
// Permission Module - Public API
// PRIMARY: The per-rule permission layer (allow/ask/deny) plus the agent ceiling
// =============================================================================

// Per-rule permission layer (spec: 2026-07-18-permission-rules.md)
export type {
  PermissionRule,
  PermissionRuleDecision,
  PermissionRuleSet,
  PermissionSettings,
  PermissionEvaluation,
  PermissionScope,
} from "./rule-types.js";
export { emptyRuleSet } from "./rule-types.js";
export { parseRule, parseRules, parseRuleSet, ruleMatches, findMatch } from "./rules.js";
export { suggestRule } from "./suggest.js";
export { PermissionSettingsManager, settingsPath, type RuleScope } from "./settings.js";
export { evaluatePermission, type EvaluateInput } from "./evaluate.js";
export { promptForPermission, type PermissionPromptOutcome } from "./prompt.js";
