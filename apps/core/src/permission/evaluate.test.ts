import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePermission } from "./evaluate.js";
import { parseRuleSet } from "./rules.js";
import { emptyRuleSet } from "./rule-types.js";
import { setMcpToolReadOnly, clearMcpToolKinds } from "./mode-policy.js";
import type { AgentMode } from "../agent/types.js";
import type { AgentEnvelope } from "../agent/definitions/types.js";
import type { PermissionOperation } from "../tools/tool.types.js";

const ROOT = "/proj";

function evaluate(
  mode: AgentMode,
  toolName: string,
  args: Record<string, unknown>,
  rules = emptyRuleSet(),
) {
  return evaluatePermission({ toolName, args, mode, rules, projectRoot: ROOT });
}

// =============================================================================
// Danger mode
// =============================================================================

test("danger mode allows everything, even against a deny rule", () => {
  const rules = parseRuleSet({ deny: ["Bash"] });
  const result = evaluate("danger", "bash", { command: "rm -rf /" }, rules);
  assert.deepEqual(result, { decision: "allow", source: "danger" });
});

// =============================================================================
// Mode enforcement (beats allow rules)
// =============================================================================

test("plan mode denies mutating tools even with an allow rule", () => {
  const rules = parseRuleSet({ allow: ["Write", "Bash"] });
  assert.equal(evaluate("plan", "write", { filePath: "/proj/a.ts" }, rules).decision, "deny");
  assert.equal(evaluate("plan", "bash", { command: "ls" }, rules).decision, "deny");
  assert.equal(evaluate("plan", "write", {}).source, "mode-enforced");
});

test("plan and explore modes allow read-only tools", () => {
  assert.equal(evaluate("plan", "read", { filePath: "/proj/a.ts" }).decision, "allow");
  assert.equal(evaluate("explore", "grep", { pattern: "x" }).decision, "allow");
});

test("review mode denies write/edit/agent but lets rules allow bash", () => {
  const rules = parseRuleSet({ allow: ["Bash(git diff:*)"] });
  assert.equal(evaluate("review", "write", { filePath: "/proj/a" }, rules).decision, "deny");
  assert.equal(evaluate("review", "bash", { command: "git diff HEAD" }, rules).decision, "allow");
  // unmatched bash in review → deny, never ask
  assert.equal(evaluate("review", "bash", { command: "npm install" }, rules).decision, "deny");
});

test("explore never asks — ask outcomes downgrade to deny", () => {
  const rules = parseRuleSet({ ask: ["Read(./secrets/**)"] });
  const result = evaluate("explore", "read", { filePath: "/proj/secrets/k" }, rules);
  assert.equal(result.decision, "deny");
});

// =============================================================================
// Rule precedence: deny > ask > allow, session grants never beat deny
// =============================================================================

test("deny beats ask and allow for the same call", () => {
  const rules = parseRuleSet({
    allow: ["Bash(git push:*)"],
    ask: ["Bash(git push:*)"],
    deny: ["Bash(git push:*)"],
  });
  const result = evaluate("build", "bash", { command: "git push origin" }, rules);
  assert.equal(result.decision, "deny");
  assert.equal(result.source, "rule");
  assert.equal(result.matchedRule, "Bash(git push:*)");
});

test("a session grant (allow tier) cannot override a deny rule", () => {
  // settings manager appends session grants to the allow tier; deny still wins
  const rules = parseRuleSet({ allow: ["Read(./secrets/**)"], deny: ["Read(./secrets/**)"] });
  assert.equal(evaluate("build", "read", { filePath: "/proj/secrets/k" }, rules).decision, "deny");
});

test("ask beats allow", () => {
  const rules = parseRuleSet({ allow: ["Write"], ask: ["Write(./prod/**)"] });
  assert.equal(evaluate("build", "write", { filePath: "/proj/prod/a" }, rules).decision, "ask");
  assert.equal(evaluate("build", "write", { filePath: "/proj/src/a" }, rules).decision, "allow");
});

// =============================================================================
// Build mode defaults (no rule matched)
// =============================================================================

test("build mode: unmatched read-only inside project allows, mutation asks", () => {
  assert.deepEqual(evaluate("build", "read", { filePath: "/proj/a.ts" }), {
    decision: "allow",
    source: "mode-default",
  });
  assert.equal(evaluate("build", "write", { filePath: "/proj/a.ts" }).decision, "ask");
  assert.equal(evaluate("build", "bash", { command: "ls" }).decision, "ask");
});

test("build mode: reads outside the project root and network tools ask", () => {
  assert.equal(evaluate("build", "read", { filePath: "/etc/passwd" }).decision, "ask");
  assert.equal(evaluate("build", "webfetch", { url: "https://x.com" }).decision, "ask");
});

test("build mode: unknown/MCP tools are mutating and ask by default", () => {
  assert.equal(evaluate("build", "mcp__linear__create_issue", {}).decision, "ask");
});

test("an MCP tool its server declared read-only stops asking", () => {
  const tool = "mcp__linear__search_issues";
  assert.equal(evaluate("build", tool, {}).decision, "ask");

  // What a server sends as `readOnlyHint: true` — see mcp/init.ts.
  setMcpToolReadOnly(tool);
  assert.equal(evaluate("build", tool, {}).decision, "allow");
  // ...and read-only means it also survives the modes that hard-deny mutation.
  assert.equal(evaluate("plan", tool, {}).decision, "allow");

  clearMcpToolKinds("mcp__linear__");
});

test("a disconnected server's read-only claims do not outlive it", () => {
  const tool = "mcp__scratch__peek";
  setMcpToolReadOnly(tool);
  assert.equal(evaluate("plan", tool, {}).decision, "allow");

  // Otherwise a later server reusing the name would inherit the exemption.
  clearMcpToolKinds("mcp__scratch__");
  assert.equal(evaluate("plan", tool, {}).decision, "deny");
});

test("one server's read-only claim does not cover its neighbours", () => {
  setMcpToolReadOnly("mcp__linear__search_issues");
  assert.equal(evaluate("build", "mcp__github__create_pr", {}).decision, "ask");
  clearMcpToolKinds("mcp__linear__");
});

test("allow rules satisfy build-mode asks", () => {
  const rules = parseRuleSet({ allow: ["Bash(npm run test:*)", "mcp__linear"] });
  assert.equal(evaluate("build", "bash", { command: "npm run test" }, rules).decision, "allow");
  assert.equal(evaluate("build", "mcp__linear__create_issue", {}, rules).decision, "allow");
});

// =============================================================================
// The agent envelope is a ceiling above the mode — including above `danger`
// Spec: docs/specs/2026-09-27-agent-control-and-definitions.md §5.4, §5.7
// =============================================================================

const WRITE_ENVELOPE: AgentEnvelope = {
  operations: ["file.write"],
  write: ["docs/**"],
};

function evaluateEnveloped(
  mode: AgentMode,
  toolName: string,
  args: Record<string, unknown>,
  envelope: AgentEnvelope,
  operations: PermissionOperation[],
  rules = emptyRuleSet(),
  projectRoot = ROOT,
) {
  return evaluatePermission({
    toolName,
    args,
    mode,
    rules,
    projectRoot,
    envelope,
    operations,
  });
}

test("an envelope denial outranks danger mode", () => {
  const result = evaluateEnveloped(
    "danger",
    "write",
    { filePath: join(ROOT, "outside.txt") },
    WRITE_ENVELOPE,
    ["file.write"],
  );
  assert.equal(result.decision, "deny");
  assert.equal(result.source, "envelope");
  assert.match(result.reason ?? "", /write/);
  assert.match(result.reason ?? "", /docs\/\*\*/);
});

test("inside the envelope, danger mode still allows", () => {
  const result = evaluateEnveloped(
    "danger",
    "write",
    { filePath: join(ROOT, "docs/a.md") },
    WRITE_ENVELOPE,
    ["file.write"],
  );
  assert.deepEqual(result, { decision: "allow", source: "danger" });
});

test("an allow rule cannot widen the envelope", () => {
  const result = evaluateEnveloped(
    "build",
    "write",
    { filePath: join(ROOT, "outside.txt") },
    WRITE_ENVELOPE,
    ["file.write"],
    parseRuleSet({ allow: ["Write"] }),
  );
  assert.equal(result.decision, "deny");
  assert.equal(result.source, "envelope");
});

test("an operation the envelope withholds is denied, whatever the mode allows", () => {
  const result = evaluateEnveloped("danger", "bash", { command: "ls" }, WRITE_ENVELOPE, [
    "shell",
  ]);
  assert.equal(result.decision, "deny");
  assert.match(result.reason ?? "", /shell/);
});

test("a tool with no declared operations and no grant is denied", () => {
  const result = evaluateEnveloped(
    "build",
    "mcp__linear__issues",
    {},
    { operations: ["file.read"], read: ["docs/**"] },
    [],
  );
  assert.equal(result.decision, "deny");
  assert.match(result.reason ?? "", /not granted mcp__linear__issues/);
});

test("no envelope leaves every mode exactly as it was", () => {
  assert.deepEqual(evaluate("danger", "write", { filePath: join(ROOT, "x") }), {
    decision: "allow",
    source: "danger",
  });
  assert.equal(evaluate("plan", "write", { filePath: join(ROOT, "x") }).source, "mode-enforced");
  assert.equal(evaluate("build", "write", { filePath: join(ROOT, "x") }).decision, "ask");
});

test("the envelope judges the resolved path, so a symlink cannot escape", () => {
  const project = mkdtempSync(join(tmpdir(), "freecode-evaluate-envelope-"));
  mkdirSync(join(project, "docs"));
  mkdirSync(join(project, "outside"));
  symlinkSync(join(project, "outside"), join(project, "docs", "escape"));

  const result = evaluateEnveloped(
    "build",
    "write",
    { filePath: "docs/escape/evil.txt" },
    WRITE_ENVELOPE,
    ["file.write"],
    emptyRuleSet(),
    project,
  );
  assert.equal(result.decision, "deny");
  assert.equal(result.source, "envelope");
});
