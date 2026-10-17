// =============================================================================
// Agent Envelope — the ceiling a definition declares, enforced
// One pure decision for a tool call, plus the two helpers it needs: what an
// envelope's `network`/`shell` booleans really grant, and how a parent's
// envelope and a child's intersect.
//
// A ceiling, not a policy: the envelope runs before mode, before `danger` and
// before rules (`permission/evaluate.ts`), so nothing downstream can widen it.
// Spec: docs/specs/2026-09-27-agent-control-and-definitions.md §5.3–§5.7
// =============================================================================

import * as path from "path";
import type { AgentEnvelope } from "../agent/definitions/types.js";
import type { PermissionOperation } from "../tools/tool.types.js";
import { extractTarget, matchPath, realpathOrSelf, targetKind } from "./rules.js";

/**
 * Tools that only touch session state. They reach nothing outside the session,
 * so an envelope neither grants nor withholds them (spec §6 Q11).
 *
 * A fixed name list, never "any tool that declares no operations": a future
 * tool must not inherit an exemption it was never granted.
 */
export const ENVELOPE_EXEMPT_TOOLS: ReadonlySet<string> = new Set([
  "todowrite",
  "question",
  "bashoutput",
  "finish_iteration",
]);

/**
 * The reason a granted `shell` is refused on a build that cannot sandbox it
 * (spec §5.7). Exported so the tool itself, which can be reached without the
 * permission gate, refuses with the same words.
 */
export const SHELL_DENIED_NO_SANDBOX =
  "shell is denied: this build cannot sandbox a shell";

export interface EnvelopeQuery {
  envelope: AgentEnvelope;
  toolName: string;
  /** The tool's declared `permissions.operations`; `[]` when it declares none. */
  operations: readonly PermissionOperation[];
  kind: "path" | "url" | "command" | "agent" | "none";
  /** The call's target, at execution time only — the tool list has no args. */
  target?: string;
  projectRoot: string;
  /**
   * Whether this build can actually build a sandbox. Supplied at execution
   * time only: the tool list must stay offered so the model reads a reason
   * rather than silently losing `bash`. Undefined means "not considered",
   * which is what every non-shell decision wants.
   */
  sandboxAvailable?: boolean;
}

export type EnvelopeVerdict =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

/**
 * The operations an envelope really grants: what it lists, minus what a boolean
 * vetoes. `network: false` can only narrow, never grant — the operation list is
 * the grant (spec §5.3).
 */
export function resolveOperations(envelope: AgentEnvelope): Set<PermissionOperation> {
  const ops = new Set(envelope.operations);
  if (envelope.network === false) ops.delete("network");
  if (envelope.shell === false) ops.delete("shell");
  return ops;
}

export function envelopeDecision(query: EnvelopeQuery): EnvelopeVerdict {
  const { envelope, toolName, operations, kind } = query;
  const tool = toolName.toLowerCase();

  if (ENVELOPE_EXEMPT_TOOLS.has(tool)) return { decision: "allow" };

  const granted = (envelope.grants ?? []).some((grant) => grantCovers(grant, tool));

  // `buildTool` defaults an undeclared list to empty, and a forgotten
  // declaration is indistinguishable from an honest one: fail closed (§5.6).
  if (operations.length === 0) {
    return granted
      ? { decision: "allow" }
      : deny(`this agent was not granted ${toolName}`);
  }

  const allowed = resolveOperations(envelope);
  const missing = operations.find((op) => !allowed.has(op));
  if (missing) {
    return deny(
      `tool ${toolName} needs the ${missing} operation; this agent's envelope allows: ${
        [...allowed].join(", ") || "none"
      }`,
    );
  }

  // A granted `shell` that this build cannot sandbox is denied, never run
  // unsandboxed: the mount boundaries ARE the write enforcement (§5.5). Only
  // execution passes the flag, so the tool list stays offered and the model
  // reads the reason instead of silently losing `bash`.
  if (query.sandboxAvailable === false && operations.includes("shell")) {
    return deny(SHELL_DENIED_NO_SANDBOX);
  }

  if (kind === "path") {
    // The tool list has no args: there is no target to check yet, and the
    // execution site is the authoritative gate (§5.4).
    if (query.target === undefined) return { decision: "allow" };
    const axes = rootAxes(operations);
    const roots = rootsFor(envelope, axes);
    if (!roots.some((root) => matchPath(root, query.target, query.projectRoot))) {
      const axis = axes.join("/");
      // The spec's own wording: "write to X", "read of X" (§5.7).
      const verb = axis === "write" ? "to" : "of";
      return deny(
        `${axis} ${verb} ${query.target} is outside this agent's ${axis} roots (${
          roots.join(", ") || "none"
        })`,
      );
    }
    return { decision: "allow" };
  }

  // url and command targets have no allowlist in v1, and the agent family's
  // target is a sub-agent type: for all three the operation gate above is the
  // whole gate. A target-less tool has no root to check, so it needs a grant.
  if (kind === "url" || kind === "command" || kind === "agent") {
    return { decision: "allow" };
  }
  return granted
    ? { decision: "allow" }
    : deny(`this agent was not granted ${toolName}`);
}

/**
 * A grant names a tool exactly, or an MCP server's tools as `mcp__server` —
 * the same grammar permission rules use (`rules.ts` `ruleMatches`), so a
 * `grants: [mcp__linear]` entry covers `mcp__linear__issues` and a plain name
 * covers only itself.
 */
function grantCovers(grant: string, tool: string): boolean {
  const name = grant.toLowerCase();
  return name === tool || (name.startsWith("mcp__") && tool.startsWith(`${name}__`));
}

/** Which root lists a tool's operations answer to. */
function rootAxes(operations: readonly PermissionOperation[]): Array<"read" | "write"> {  const axes: Array<"read" | "write"> = [];
  if (operations.includes("file.read")) axes.push("read");
  if (operations.includes("file.write") || operations.includes("file.delete")) {
    axes.push("write");
  }
  return axes;
}

function rootsFor(
  envelope: AgentEnvelope,
  axes: ReadonlyArray<"read" | "write">,
): string[] {
  const roots: string[] = [];
  for (const axis of axes) {
    if (axis === "read") {
      // write roots are readable: an agent that cannot read what it is told to
      // edit cannot work (§5.3).
      roots.push(...(envelope.read ?? []), ...(envelope.write ?? []));
    } else {
      roots.push(...(envelope.write ?? []));
    }
  }
  return roots;
}

/**
 * The call's target with symlinks resolved, and the family it belongs to.
 *
 * Resolution is deliberately here and not inside `envelopeDecision`: the
 * decision stays pure and lexical, while this walks the filesystem so a symlink
 * out of the roots is judged by where it points. `projectRoot` is the base a
 * relative target resolves against — and, for a path tool that was called
 * without a usable path argument, the target itself: `ls`, `glob` and `grep`
 * default to the working directory, so treating a missing argument as "nothing
 * to check" let a model read outside the roots by simply omitting it. A
 * malformed argument (a number, a boolean) is the same case, and must not reach
 * `path.resolve`, which throws and would take the turn down with it.
 */
export function resolveEnvelopeTarget(
  toolName: string,
  args: Record<string, unknown>,
  projectRoot: string,
): { kind: EnvelopeQuery["kind"]; target?: string } {
  const kind = targetKind(toolName) ?? "none";
  if (kind === "none") return { kind };
  const raw = extractTarget(toolName, args);
  const target = typeof raw === "string" ? raw : undefined;
  if (kind !== "path") return target === undefined ? { kind } : { kind, target };
  const resolved = realpathOrSelf(path.resolve(projectRoot, target ?? projectRoot));
  return { kind, target: resolved };
}

/**
 * Effective envelope = parent ∩ child, axis by axis (spec §5.4). Undefined on
 * either side means "no ceiling from that side", so the other side stands.
 */
export function intersectEnvelopes(
  parent: AgentEnvelope | undefined,
  child: AgentEnvelope | undefined,
): AgentEnvelope | undefined {
  if (!parent) return child;
  if (!child) return parent;
  return {
    operations: child.operations.filter((op) => parent.operations.includes(op)),
    read: containedOnly(parent.read, child.read),
    write: containedOnly(parent.write, child.write),
    network: parent.network === false || child.network === false ? false : undefined,
    shell: parent.shell === false || child.shell === false ? false : undefined,
    grants: grantsOnly(parent, child),
  };
}

/**
 * A child root survives only if a parent root contains it. Textual and
 * fail-closed: a root that is not textually contained is dropped, so the
 * failure direction is a child that is too narrow, never one that is too wide.
 */
function containedOnly(
  parentRoots: string[] | undefined,
  childRoots: string[] | undefined,
): string[] | undefined {
  if (childRoots === undefined) return undefined;
  if (parentRoots === undefined) return undefined;
  const kept = childRoots.filter((child) =>
    parentRoots.some((parent) => contains(parent, child)),
  );
  return kept.length > 0 ? kept : undefined;
}

function contains(parentRoot: string, childRoot: string): boolean {
  const p = parentRoot.endsWith("/**") ? parentRoot.slice(0, -3) : parentRoot;
  if (p === "" || p === "**") return true; // every path
  if (p === "//") return childRoot.startsWith("//"); // every absolute path
  return childRoot === p || childRoot.startsWith(`${p}/`);
}

function grantsOnly(
  parent: AgentEnvelope,
  child: AgentEnvelope,
): string[] | undefined {
  const parentGrants = parent.grants;
  if (child.grants === undefined || parentGrants === undefined) return undefined;
  const kept = child.grants.filter((grant) =>
    parentGrants.some((parentGrant) => grantCovers(parentGrant, grant.toLowerCase())),
  );
  return kept.length > 0 ? kept : undefined;
}

function deny(reason: string): EnvelopeVerdict {
  return { decision: "deny", reason };
}
