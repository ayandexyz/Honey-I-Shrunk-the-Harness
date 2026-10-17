// =============================================================================
// The agent envelope predicate — one pure decision, plus the two helpers it
// needs (which operations an envelope really grants, and how two envelopes
// intersect).
// Spec: docs/specs/2026-09-27-agent-control-and-definitions.md §5.3–§5.7, §5.9
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENVELOPE_EXEMPT_TOOLS,
  envelopeDecision,
  intersectEnvelopes,
  resolveEnvelopeTarget,
  resolveOperations,
  type EnvelopeQuery,
  type EnvelopeVerdict,
} from "./envelope.js";
import { targetKind } from "./rules.js";
import type { AgentEnvelope } from "../agent/definitions/types.js";
import type { PermissionOperation } from "../tools/tool.types.js";

const ROOT = "/proj";
type Kind = EnvelopeQuery["kind"];

/** One tool call against one envelope, with every axis the caller can vary. */
function decide(
  envelope: AgentEnvelope,
  toolName: string,
  operations: readonly PermissionOperation[],
  kind: Kind,
  target?: string,
  projectRoot: string = ROOT,
): EnvelopeVerdict {
  return envelopeDecision({
    envelope,
    toolName,
    operations,
    kind,
    ...(target === undefined ? {} : { target }),
    projectRoot,
  });
}

function reasonOf(verdict: EnvelopeVerdict): string {
  assert.equal(verdict.decision, "deny", "expected a denial, got an allow");
  return verdict.decision === "deny" ? verdict.reason : "";
}

/** The tool that exercises each operation, and the envelope that grants it. */
const PER_OPERATION: Record<
  PermissionOperation,
  { tool: string; kind: Kind; target?: string; envelope: AgentEnvelope }
> = {
  "file.read": {
    tool: "read",
    kind: "path",
    target: "docs/a.md",
    envelope: { operations: ["file.read"], read: ["docs/**"] },
  },
  "file.write": {
    tool: "write",
    kind: "path",
    target: "docs/a.md",
    envelope: { operations: ["file.write"], write: ["docs/**"] },
  },
  "file.delete": {
    tool: "write",
    kind: "path",
    target: "docs/a.md",
    envelope: { operations: ["file.delete"], write: ["docs/**"] },
  },
  network: {
    tool: "webfetch",
    kind: "url",
    target: "https://example.com",
    envelope: { operations: ["network"] },
  },
  shell: {
    tool: "bash",
    kind: "command",
    target: "pnpm test",
    envelope: { operations: ["shell"] },
  },
  subprocess: {
    tool: "lsp",
    kind: "none",
    envelope: { operations: ["subprocess"], grants: ["lsp"] },
  },
  mcp: {
    tool: "mcp__linear__issues",
    kind: "none",
    envelope: { operations: ["mcp"], grants: ["mcp__linear__issues"] },
  },
  "agent.spawn": {
    tool: "agent",
    kind: "agent",
    envelope: { operations: ["agent.spawn"] },
  },
};

const OPERATIONS = Object.keys(PER_OPERATION) as PermissionOperation[];

// -----------------------------------------------------------------------------
// The operation gate
// -----------------------------------------------------------------------------

for (const operation of OPERATIONS) {
  const spec = PER_OPERATION[operation];

  test(`an envelope granting ${operation} allows that operation`, () => {
    const verdict = decide(
      spec.envelope,
      spec.tool,
      [operation],
      spec.kind,
      spec.target,
    );
    assert.equal(verdict.decision, "allow");
  });

  test(`an envelope withholding ${operation} denies it and names it`, () => {
    const verdict = decide(
      { ...spec.envelope, operations: [] },
      spec.tool,
      [operation],
      spec.kind,
      spec.target,
    );
    assert.match(reasonOf(verdict), new RegExp(operation.replace(".", "\\.")));
  });
}

test("a tool needing two operations is denied when the envelope grants only one", () => {
  const verdict = decide(
    { operations: ["file.read"], read: ["docs/**"], grants: ["lsp"] },
    "lsp",
    ["file.read", "subprocess"],
    "none",
  );
  assert.match(reasonOf(verdict), /subprocess/);
});

test("a granted tool still needs its operations — a grant exempts the target check only", () => {
  const verdict = decide(
    { operations: ["file.read"], read: ["docs/**"], grants: ["lsp"] },
    "lsp",
    ["file.read", "subprocess"],
    "none",
  );
  assert.equal(verdict.decision, "deny");
});

// -----------------------------------------------------------------------------
// The root check
// -----------------------------------------------------------------------------

test("a read inside the read roots is allowed", () => {
  const verdict = decide(
    { operations: ["file.read"], read: ["docs/**"] },
    "read",
    ["file.read"],
    "path",
    "docs/a/b.md",
  );
  assert.equal(verdict.decision, "allow");
});

test("a root covers the directory itself, not only its contents", () => {
  const verdict = decide(
    { operations: ["file.read"], read: ["docs/**"] },
    "grep",
    ["file.read"],
    "path",
    "docs",
  );
  assert.equal(verdict.decision, "allow");
});

test("a read outside the read roots is denied with the axis, target and roots", () => {
  const verdict = decide(
    { operations: ["file.read"], read: ["docs/**"] },
    "read",
    ["file.read"],
    "path",
    "other/a.md",
  );
  const reason = reasonOf(verdict);
  assert.match(reason, /read/);
  assert.match(reason, /other\/a\.md/);
  assert.match(reason, /docs\/\*\*/);
});

test("an absolute root is matched against an absolute target", () => {
  const verdict = decide(
    { operations: ["file.read"], read: ["//etc/hosts"] },
    "read",
    ["file.read"],
    "path",
    "/etc/hosts",
  );
  assert.equal(verdict.decision, "allow");
});

test("an absolute target outside a project-relative root is denied", () => {
  const verdict = decide(
    { operations: ["file.read"], read: ["docs/**"] },
    "read",
    ["file.read"],
    "path",
    "/etc/hosts",
  );
  assert.equal(verdict.decision, "deny");
});

test("`..` cannot climb out of a root", () => {
  const verdict = decide(
    { operations: ["file.read"], read: ["docs/**"] },
    "read",
    ["file.read"],
    "path",
    "docs/../secret.md",
  );
  assert.equal(verdict.decision, "deny");
});

test("write roots bound a write, and a readable root is not writable", () => {
  const envelope: AgentEnvelope = {
    operations: ["file.read", "file.write"],
    read: ["docs/**"],
    write: ["src/**"],
  };
  assert.equal(
    decide(envelope, "read", ["file.read"], "path", "docs/a.md").decision,
    "allow",
  );
  assert.equal(
    decide(envelope, "write", ["file.write"], "path", "docs/a.md").decision,
    "deny",
  );
  assert.equal(
    decide(envelope, "write", ["file.write"], "path", "src/a.ts").decision,
    "allow",
  );
});

test("write roots are readable — an agent must read what it edits", () => {
  const verdict = decide(
    { operations: ["file.read", "file.write"], read: ["src/**"], write: ["docs/**"] },
    "read",
    ["file.read"],
    "path",
    "docs/a.md",
  );
  assert.equal(verdict.decision, "allow");
});

// -----------------------------------------------------------------------------
// Symlinks — the target the predicate sees is the resolved one
// -----------------------------------------------------------------------------

test("a symlink pointing outside the roots is denied, and the same link inside is allowed", () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-envelope-"));
  mkdirSync(join(project, "docs", "real"), { recursive: true });
  mkdirSync(join(project, "outside"), { recursive: true });
  symlinkSync(join(project, "outside"), join(project, "docs", "escape"));
  symlinkSync(join(project, "docs", "real"), join(project, "docs", "alias"));

  const envelope: AgentEnvelope = { operations: ["file.write"], write: ["docs/**"] };

  const escaping = resolveEnvelopeTarget(
    "write",
    { filePath: "docs/escape/evil.txt" },
    project,
  );
  assert.equal(escaping.kind, "path");
  const denied = envelopeDecision({
    envelope,
    toolName: "write",
    operations: ["file.write"],
    kind: escaping.kind,
    target: escaping.target,
    projectRoot: project,
  });
  assert.equal(denied.decision, "deny", "a symlink out of the roots must not pass");

  const inside = resolveEnvelopeTarget(
    "write",
    { filePath: "docs/alias/kept.txt" },
    project,
  );
  const allowed = envelopeDecision({
    envelope,
    toolName: "write",
    operations: ["file.write"],
    kind: inside.kind,
    target: inside.target,
    projectRoot: project,
  });
  assert.equal(allowed.decision, "allow", "a symlink inside the roots is still inside");
});

test("a file that does not exist yet is judged by its nearest existing ancestor", () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-envelope-new-"));
  const resolved = resolveEnvelopeTarget(
    "write",
    { filePath: "docs/deep/new/file.txt" },
    project,
  );
  assert.equal(resolved.kind, "path");
  assert.ok(resolved.target?.endsWith(join("docs", "deep", "new", "file.txt")));
});

test("resolveEnvelopeTarget classifies each family and only resolves paths", () => {
  assert.deepEqual(
    { ...resolveEnvelopeTarget("read", { filePath: "docs/a.md" }, ROOT), target: "<path>" },
    { kind: "path", target: "<path>" },
  );
  assert.deepEqual(resolveEnvelopeTarget("webfetch", { url: "https://x.test" }, ROOT), {
    kind: "url",
    target: "https://x.test",
  });
  assert.deepEqual(resolveEnvelopeTarget("bash", { command: "ls" }, ROOT), {
    kind: "command",
    target: "ls",
  });
  assert.equal(resolveEnvelopeTarget("lsp", {}, ROOT).kind, "none");
});

// -----------------------------------------------------------------------------
// Tools with no boundable target, and tools with no declared operations
// -----------------------------------------------------------------------------

test("a tool with no boundable target needs a grant", () => {
  const denied = decide({ operations: ["file.read"], read: ["docs/**"] }, "lsp", ["file.read"], "none");
  assert.match(reasonOf(denied), /not granted lsp/);

  const granted = decide(
    { operations: ["file.read"], read: ["docs/**"], grants: ["lsp"] },
    "lsp",
    ["file.read"],
    "none",
  );
  assert.equal(granted.decision, "allow");
});

test("a grant is matched case-insensitively", () => {
  const granted = decide(
    { operations: ["file.read"], read: ["docs/**"], grants: ["LSP"] },
    "lsp",
    ["file.read"],
    "none",
  );
  assert.equal(granted.decision, "allow");
});

test("a tool that declares no operations needs a grant", () => {
  const denied = decide({ operations: ["file.read"], read: ["docs/**"] }, "ghost_tool", [], "none");
  assert.match(reasonOf(denied), /not granted ghost_tool/);
  assert.equal(
    decide(
      { operations: ["file.read"], read: ["docs/**"], grants: ["ghost_tool"] },
      "ghost_tool",
      [],
      "none",
    ).decision,
    "allow",
  );
});

test("the session-state tools are exempt", () => {
  assert.deepEqual(
    [...ENVELOPE_EXEMPT_TOOLS].sort(),
    ["bashoutput", "finish_iteration", "question", "todowrite"],
  );
  for (const name of ENVELOPE_EXEMPT_TOOLS) {
    assert.equal(
      decide({ operations: [] }, name, [], "none").decision,
      "allow",
      `${name} should not need a declaration`,
    );
  }
});

test("url, command and agent targets are gated by their operation alone", () => {
  assert.equal(
    decide({ operations: ["network"] }, "webfetch", ["network"], "url", "https://anything.test").decision,
    "allow",
  );
  assert.equal(
    decide({ operations: ["shell"] }, "bash", ["shell"], "command", "rm -rf /tmp/x").decision,
    "allow",
  );
  assert.equal(
    decide({ operations: ["agent.spawn"] }, "agent", ["agent.spawn"], "agent", "reviewer").decision,
    "allow",
  );
});

// -----------------------------------------------------------------------------
// The filter's call: no target, so only the static half is decided
// -----------------------------------------------------------------------------

test("without a target the root check is deferred but the grant rule is not", () => {
  assert.equal(
    decide({ operations: ["file.write"], write: ["docs/**"] }, "write", ["file.write"], "path")
      .decision,
    "allow",
    "the tool list has no args; the path check belongs to execution",
  );
  assert.equal(
    decide({ operations: ["file.write"], write: ["docs/**"] }, "lsp", ["file.write"], "none")
      .decision,
    "deny",
    "a target-less tool the envelope will never grant is pruned from the list",
  );
});

// -----------------------------------------------------------------------------
// network / shell narrow only (R2)
// -----------------------------------------------------------------------------

test("network: false withholds the network operation", () => {
  const envelope: AgentEnvelope = { operations: ["network"], network: false };
  assert.equal(resolveOperations(envelope).has("network"), false);
  assert.match(
    reasonOf(decide(envelope, "webfetch", ["network"], "url", "https://x.test")),
    /network/,
  );
});

test("network: true leaves the declared operation alone", () => {
  const envelope: AgentEnvelope = { operations: ["network"], network: true };
  assert.equal(resolveOperations(envelope).has("network"), true);
  assert.equal(decide(envelope, "webfetch", ["network"], "url", "https://x.test").decision, "allow");
});

test("shell: false withholds the shell operation", () => {
  const envelope: AgentEnvelope = { operations: ["shell"], shell: false };
  assert.equal(resolveOperations(envelope).has("shell"), false);
  assert.equal(decide(envelope, "bash", ["shell"], "command", "ls").decision, "deny");
});

test("a boolean never grants an operation the list omits", () => {
  assert.equal(resolveOperations({ operations: [], shell: true }).has("shell"), false);
});

// -----------------------------------------------------------------------------
// targetKind
// -----------------------------------------------------------------------------

test("targetKind classifies the tool families", () => {
  for (const name of ["read", "write", "edit", "ls", "glob", "grep"]) {
    assert.equal(targetKind(name), "path", name);
  }
  assert.equal(targetKind("webfetch"), "url");
  assert.equal(targetKind("websearch"), "url");
  assert.equal(targetKind("bash"), "command");
  assert.equal(targetKind("monitor"), "command");
  assert.equal(targetKind("agent"), "agent");
  assert.equal(targetKind("agent_send"), "agent");
  assert.equal(targetKind("agent_stop"), "agent");
  for (const name of ["lsp", "memory", "skill", "todowrite", "mcp__linear__issues", "bashoutput"]) {
    assert.equal(targetKind(name), undefined, name);
  }
});

// -----------------------------------------------------------------------------
// Intersection (R4, R7)
// -----------------------------------------------------------------------------

test("no parent and no child is no envelope at all", () => {
  assert.equal(intersectEnvelopes(undefined, undefined), undefined);
});

test("one side alone stands unchanged", () => {
  const child: AgentEnvelope = { operations: ["file.read"], read: ["docs/**"] };
  assert.deepEqual(intersectEnvelopes(undefined, child), child);
  const parent: AgentEnvelope = { operations: ["file.write"], write: ["src/**"] };
  assert.deepEqual(intersectEnvelopes(parent, undefined), parent);
});

test("operations intersect", () => {
  const merged = intersectEnvelopes(
    { operations: ["file.read", "file.write", "shell"] },
    { operations: ["file.write", "shell", "network"] },
  );
  assert.deepEqual(merged?.operations, ["file.write", "shell"]);
});

test("a child root survives only when a parent root contains it", () => {
  const survives = intersectEnvelopes(
    { operations: ["file.read"], read: ["docs/**"] },
    { operations: ["file.read"], read: ["docs/a/**"] },
  );
  assert.deepEqual(survives?.read, ["docs/a/**"]);

  const dropped = intersectEnvelopes(
    { operations: ["file.read"], read: ["docs/**"] },
    { operations: ["file.read"], read: ["**"] },
  );
  assert.equal(dropped?.read, undefined, "a wider child root cannot survive");
});

test("a parent root of ** contains any child root", () => {
  const merged = intersectEnvelopes(
    { operations: ["file.read"], read: ["**"] },
    { operations: ["file.read"], read: ["docs/**", "src/a.ts"] },
  );
  assert.deepEqual(merged?.read, ["docs/**", "src/a.ts"]);
});

test("a parent root contains the directory it names", () => {
  const merged = intersectEnvelopes(
    { operations: ["file.read"], read: ["docs/**"] },
    { operations: ["file.read"], read: ["docs"] },
  );
  assert.deepEqual(merged?.read, ["docs"]);
});

test("an uncontained root is dropped, and an emptied list is no roots", () => {
  const merged = intersectEnvelopes(
    { operations: ["file.read"], read: ["docs/**"] },
    { operations: ["file.read"], read: ["src/**"] },
  );
  assert.equal(merged?.read, undefined);
});

test("network and shell are and-ed", () => {
  const merged = intersectEnvelopes(
    { operations: ["network", "shell"] },
    { operations: ["network", "shell"], network: false },
  );
  assert.equal(merged?.network, false);
  assert.equal(merged?.shell, undefined);

  const bothTrue = intersectEnvelopes(
    { operations: ["shell"] },
    { operations: ["shell"], shell: true },
  );
  assert.equal(bothTrue?.shell, undefined, "true is not a narrowing");
});

test("grants intersect", () => {
  const merged = intersectEnvelopes(
    { operations: ["mcp"], grants: ["mcp__linear", "mcp__notion"] },
    { operations: ["mcp"], grants: ["mcp__notion", "mcp__slack"] },
  );
  assert.deepEqual(merged?.grants, ["mcp__notion"]);
});

test("a child with no grants has none", () => {
  const merged = intersectEnvelopes(
    { operations: ["mcp"], grants: ["mcp__linear"] },
    { operations: ["mcp"] },
  );
  assert.equal(merged?.grants, undefined);
});
