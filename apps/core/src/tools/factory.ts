// =============================================================================
// Tool Factory - buildTool() factory for creating Tool instances
// PRIMARY: Provides sensible defaults for all tool properties
// Based on Claude Code's buildTool() pattern
// =============================================================================

import type {
  Tool,
  ToolBehavior,
  ToolPermissions,
  ToolExecutionResult,
  ValidationResult,
  PermissionCheckResult,
  JsonSchema,
} from "./tool.types.js";
import type { ToolContext } from "./types.js";

// =============================================================================
// Default Behavior
// =============================================================================

export const defaultBehavior: ToolBehavior = {
  isConcurrencySafe: false,
  isDestructive: false,
  userFacingName: "",
};

// =============================================================================
// Default Permissions
// =============================================================================

export const defaultPermissions: ToolPermissions = {
  operations: [],
};

// =============================================================================
// buildTool() - Factory for creating Tool instances with sensible defaults
// =============================================================================

export function buildTool<P, R>(config: {
  id: string;
  description: string;
  schemas: { parameters: JsonSchema; result?: JsonSchema };
  permissions?: Partial<ToolPermissions>;
  behavior?: Partial<ToolBehavior>;
  execute: (params: P, ctx: ToolContext) => Promise<ToolExecutionResult<R>>;
  validateInput?: (params: unknown) => ValidationResult;
  checkPermissions?: (
    params: P,
    ctx: ToolContext,
  ) => Promise<PermissionCheckResult>;
}): Tool<P, R> {
  const fullPermissions: ToolPermissions = {
    ...defaultPermissions,
    ...config.permissions,
  };

  const fullBehavior: ToolBehavior = {
    ...defaultBehavior,
    ...config.behavior,
    userFacingName: config.behavior?.userFacingName || config.id,
  };

  return {
    id: config.id,
    description: config.description,
    schemas: config.schemas as Tool<P, R>["schemas"],
    behavior: fullBehavior,
    permissions: fullPermissions,
    execute: config.execute as Tool<P, R>["execute"],
    validateInput: config.validateInput,
    checkPermissions: config.checkPermissions as Tool<P, R>["checkPermissions"],
  };
}
