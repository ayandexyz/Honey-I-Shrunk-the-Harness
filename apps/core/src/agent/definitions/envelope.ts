// =============================================================================
// An agent definition's capability envelope — the `envelope:` frontmatter block
// (spec 2026-09-27-agent-control-and-definitions.md §5.3). Closed by design: it
// states everything the agent may do, and an operation it does not name is
// denied whatever the mode or the permission rules allow.
//
//   ---
//   name: docs-writer
//   description: Edits documentation under docs/
//   tools: [read, ls, glob, grep, edit, write]
//   envelope:
//     operations: [file.read, file.write, mcp]
//     read: ["**"]
//     write: [docs/**, README.md]
//     network: false
//     shell: false
//     grants: [mcp__linear]
//   ---
//
// This file only reads and validates the block — nothing enforces it yet; the
// enforcement phases are §5.4 onwards. A definition whose envelope does not
// validate is refused at load, never loaded without it.
// =============================================================================

import { PERMISSION_OPERATIONS, type PermissionOperation } from "../../tools/tool.types.js";
import type { FrontmatterValue } from "./loader.js";
import type { AgentEnvelope } from "./types.js";

/** Every key the block accepts; anything else is a typo worth refusing. */
const KEYS = new Set(["operations", "read", "write", "network", "shell", "grants"]);

/** The path axes, and which of them each path operation needs. */
const PATH_AXES = ["read", "write"] as const;
const NEEDS_ROOTS: Partial<Record<PermissionOperation, "read" | "write">> = {
  "file.read": "read",
  "file.write": "write",
  "file.delete": "write",
};

/**
 * Frontmatter value → the list the key declares. A scalar or a nested block is
 * not a list, and reads as empty: the spec's stance is that rejection beats a
 * guess, so an undeclared axis is refused by the operation that needs it rather
 * than guessed at from a bare value.
 */
function listOf(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : [];
}

export function parseEnvelope(
  value: FrontmatterValue,
  knownTools: ReadonlySet<string>,
): AgentEnvelope | { error: string } {
  if (typeof value === "string" || Array.isArray(value)) {
    return { error: "envelope must be a block, not a value" };
  }
  for (const key of Object.keys(value)) {
    if (!KEYS.has(key)) return { error: `envelope has an unknown key "${key}"` };
  }

  const declared = listOf(value.operations);
  if (declared.length === 0) {
    return { error: "envelope.operations must list at least one operation" };
  }
  for (const op of declared) {
    if (!(PERMISSION_OPERATIONS as readonly string[]).includes(op)) {
      return { error: `envelope.operations has an unknown operation "${op}"` };
    }
  }
  const operations = declared as PermissionOperation[];

  const roots = { read: listOf(value.read), write: listOf(value.write) };
  for (const axis of PATH_AXES) {
    for (const root of roots[axis]) {
      if (!root.trim()) return { error: `envelope.${axis} has an empty root` };
      if (root.startsWith("/") && !root.startsWith("//")) {
        return {
          error: `envelope.${axis} root "${root}" is absolute; write "//${root.slice(1)}" for an absolute path`,
        };
      }
    }
  }
  for (const op of operations) {
    const axis = NEEDS_ROOTS[op];
    if (axis && roots[axis].length === 0) {
      return { error: `envelope grants ${op} but has no ${axis} roots` };
    }
  }

  const envelope: AgentEnvelope = { operations };
  if (value.read !== undefined) envelope.read = roots.read;
  if (value.write !== undefined) envelope.write = roots.write;
  for (const axis of ["network", "shell"] as const) {
    const raw = value[axis];
    if (raw === undefined) continue;
    if (raw !== "true" && raw !== "false") return { error: `envelope.${axis} must be true or false` };
    envelope[axis] = raw === "true";
  }

  const grants = listOf(value.grants);
  for (const grant of grants) {
    // MCP names are accepted on their `mcp__` prefix alone: the MCP registry is
    // empty while definitions load, so existence is unknowable here and a name no
    // server provides fails at call time instead.
    if (!knownTools.has(grant) && !grant.startsWith("mcp__")) {
      return { error: `envelope.grants has an unknown tool "${grant}"` };
    }
  }
  if (value.grants !== undefined) envelope.grants = grants;

  return envelope;
}
