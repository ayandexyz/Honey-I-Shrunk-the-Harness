// =============================================================================
// Agent definitions: Claude Code's file format parses, scopes layer in the
// right order, bad files are skipped, and a spawn from a definition gets its
// role prompt and only its tools.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freecode-agent-defs-home-"));
process.env.HOME = home;

const { parseFrontmatter, parseAgentFile, loadAgentDefinitions } = await import("./loader.js");
const { resolveSpawn } = await import("./resolve.js");
const { registerProvider } = await import("../../providers/registry.js");
const { tools } = await import("../../tools/index.js");
const { getAgentRegistry } = await import("../registry/index.js");
const { createHookRuntime } = await import("../../hooks/runtime.js");

const KNOWN = new Set(["read", "grep", "glob", "ls", "write", "edit", "bash"]);

test.after(() => rmSync(home, { recursive: true, force: true }));

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "freecode-agent-defs-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

test("frontmatter: scalar, inline list and block list", () => {
  const p = parseFrontmatter(
    "---\nname: a\ntools: [Read, \"Grep\"]\nskills:\n  - x\n  - y\nmodel: inherit # comment\n---\nBody here.\n",
  );
  assert.deepEqual(p?.fields, { name: "a", tools: ["Read", "Grep"], skills: ["x", "y"], model: "inherit" });
  assert.equal(p?.body, "Body here.");
  assert.equal(parseFrontmatter("no frontmatter"), null);
});

test("a Claude Code agent file loads: capitalised comma tools, alias model, mode inferred", () => {
  const cc = parseAgentFile(
    "---\nname: fixer\ndescription: Fixes things\ntools: Read, Edit, NotebookEdit\nmodel: sonnet\n---\nFix it.",
    "/x/fixer.md",
    "claude-code-project",
    KNOWN,
  );
  assert.deepEqual(cc?.tools, ["read", "edit"], "unknown tools dropped, names lowercased");
  assert.equal(cc?.model, undefined, "a Claude Code alias means inherit");
  assert.equal(cc?.mode, "build", "listing a writing tool means it writes");
  const ro = parseAgentFile("---\nname: r\ndescription: d\ntools: Read\n---\n", "/x/r.md", "user", KNOWN);
  assert.equal(ro?.mode, "explore");
});

test("bad files are skipped, not fatal", () => {
  assert.equal(parseAgentFile("---\nname: n\n---\nno description", "/x/n.md", "user", KNOWN), null);
  assert.equal(parseAgentFile("---\nname: n\ndescription: d\ntools: Nope\n---\n", "/x/n.md", "user", KNOWN), null);
  assert.equal(parseAgentFile("---\nname: n\ndescription: d\nmode: danger\n---\n", "/x/n.md", "user", KNOWN), null);
  assert.equal(parseAgentFile("---\nname: bad name!\ndescription: d\n---\n", "/x/n.md", "user", KNOWN), null);
});

test("scopes: project beats user beats built-in; the Claude Code scopes can be switched off", () => {
  const h = mkdtempSync(join(tmpdir(), "freecode-agent-defs-h-"));
  const dir = project({
    ".freecode/agents/reviewer.md": "---\nname: reviewer\ndescription: project reviewer\n---\n",
    ".claude/agents/cc.md": "---\nname: cc\ndescription: from claude code\n---\n",
  });
  mkdirSync(join(h, ".freecode", "agents"), { recursive: true });
  writeFileSync(join(h, ".freecode", "agents", "explorer.md"), "---\nname: explorer\ndescription: user explorer\n---\n");
  try {
    const { definitions, shadowed } = loadAgentDefinitions({ projectPath: dir, knownTools: KNOWN, homeDir: h, env: {} });
    const by = Object.fromEntries(definitions.map((d) => [d.name, d]));
    assert.equal(by.reviewer?.description, "project reviewer");
    assert.equal(by.explorer?.scope, "user");
    assert.equal(by.general?.scope, "builtin");
    assert.equal(by.cc?.scope, "claude-code-project");
    assert.deepEqual(shadowed.map((d) => `${d.name}:${d.scope}`).sort(), ["explorer:builtin", "reviewer:builtin"]);
    const off = loadAgentDefinitions({
      projectPath: dir,
      knownTools: KNOWN,
      homeDir: h,
      env: { FREECODE_CLAUDE_CODE_AGENTS: "0" },
    });
    assert.equal(off.definitions.some((d) => d.name === "cc"), false);
  } finally {
    rmSync(h, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

const info = { id: "defs-fake", name: "defs-fake", defaultModel: "m", supportsStreaming: true, supportsTools: true };
const seen: string[] = [];
/** When set, the first model call asks for this tool instead of answering. */
let firstCallTool: string | undefined;
registerProvider("defs-fake" as never, {
  info,
  create: () => ({
    info,
    execute: async () => ({ content: "", stopReason: "stop", provider: "defs-fake", model: "m", usage: { inputTokens: 1, outputTokens: 1 } }),
    stream: async function* (...args: unknown[]) {
      seen.push(JSON.stringify(args));
      if (seen.length === 1 && firstCallTool) {
        yield { type: "tool_call", id: "c1", name: firstCallTool, args: { pattern: "*" } };
      } else {
        yield { type: "text", text: "done" };
      }
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  }),
} as never);

test("resolve: unknown type or provider is refused; the old agentType alias still works both ways", () => {
  const dir = project({});
  try {
    assert.match((resolveSpawn({ subagent_type: "nope" }, dir) as { error: string }).error, /Unknown subagent_type "nope". Available: .*explorer/);
    assert.match((resolveSpawn({ model: "nope/x" }, dir) as { error: string }).error, /Unknown provider in model "nope\/x"/);
    const general = resolveSpawn({}, dir);
    assert.ok(!("error" in general) && general.definition.name === "general" && general.role === undefined);
    const asRole = resolveSpawn({ agentType: "reviewer" }, dir);
    assert.ok(!("error" in asRole) && asRole.definition.name === "reviewer");
    const asProvider = resolveSpawn({ agentType: "defs-fake" }, dir);
    assert.ok(!("error" in asProvider) && asProvider.provider === "defs-fake");
    const bogus = resolveSpawn({ agentType: "chatgpt" }, dir);
    assert.ok(!("error" in bogus) && bogus.provider === undefined, "an unknown alias is ignored, as before");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a spawn from a definition gets its role prompt and only its tools; any other call is refused", async () => {
  const dir = project({
    ".freecode/agents/probe.md":
      "---\nname: probe\ndescription: test role\ntools: Read, Grep\n---\nPROBE-ROLE-MARKER: answer tersely.",
  });
  seen.length = 0;
  firstCallTool = "glob"; // outside the allowlist: never offered, must not run
  try {
    const r = await tools.agent.execute(
      { task: "t", prompt: "p", subagent_type: "probe", model: "defs-fake" },
      { sessionId: "root-defs", cwd: dir, projectPath: dir, hooks: createHookRuntime() } as never,
    );
    assert.equal(r.success, true);
    const req = seen[0]!;
    assert.match(req, /# Your role: probe\\nPROBE-ROLE-MARKER/);
    const names = [...req.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
    assert.ok(names.includes("read") && names.includes("grep"));
    for (const hidden of ["glob", "write", "bash", "agent"]) {
      assert.ok(!names.includes(hidden), `${hidden} must not be offered`);
    }
    // The roster reaches the parent's prompt too (compiled for this project).
    assert.match(req, /# Sub-agent types[\s\S]*- probe: test role/);
    assert.match(seen[1]!, /Tool glob is not available to the probe agent. Its tools: read, grep/);
  } finally {
    firstCallTool = undefined;
    getAgentRegistry().disposeRoot("root-defs");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frontmatter: a bare key followed by indented key: lines is a map", () => {
  const p = parseFrontmatter(
    "---\nname: a\nenvelope:\n  operations: [file.read]\n  network: false\n---\nBody.",
  );
  assert.deepEqual(p?.fields, {
    name: "a",
    envelope: { operations: ["file.read"], network: "false" },
  });
});

test("frontmatter: a nested key carries an inline list or a block list", () => {
  const inline = parseFrontmatter('---\nenvelope:\n  read: ["**", README.md]\n---\n');
  assert.deepEqual(inline?.fields.envelope, { read: ["**", "README.md"] });
  const block = parseFrontmatter('---\nenvelope:\n  read:\n    - "**"\n    - README.md\n---\n');
  assert.deepEqual(block?.fields.envelope, { read: ["**", "README.md"] });
});

test("frontmatter: an indented list under a bare key stays a list", () => {
  const p = parseFrontmatter("---\nname: a\nskills:\n  - x\n  - y\n---\nBody.");
  assert.deepEqual(p?.fields, { name: "a", skills: ["x", "y"] });
});

test("frontmatter: indentation deeper than one level is ignored, not fatal", () => {
  const p = parseFrontmatter("---\nname: a\nenvelope:\n  read:\n    deep: x\n---\nBody.");
  assert.deepEqual(p?.fields, { name: "a", envelope: { read: [] } });
});

test("frontmatter: an inline list splits on commas, so a glob containing one needs the block form", () => {
  const inline = parseFrontmatter("---\nwrite: [docs/a,b.md]\n---\n");
  assert.deepEqual(inline?.fields, { write: ["docs/a", "b.md"] });
  const block = parseFrontmatter("---\nwrite:\n  - docs/a,b.md\n---\n");
  assert.deepEqual(block?.fields, { write: ["docs/a,b.md"] });
});

test("resolve: the definition's envelope rides on the role", () => {
  const dir = project({
    ".freecode/agents/doc-writer.md":
      "---\nname: doc-writer\ndescription: Docs\ntools: Read, Write\nenvelope:\n  operations: [file.read, file.write]\n  read: [\"**\"]\n  write: [docs/**]\n---\nDocs.",
  });
  try {
    const spawn = resolveSpawn({ subagent_type: "doc-writer" }, dir);
    assert.ok(spawn && "role" in spawn, "resolved");
    const role = spawn.role;
    assert.ok(role, "the role exists");
    assert.deepEqual(role.envelope, {
      operations: ["file.read", "file.write"],
      read: ["**"],
      write: ["docs/**"],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolve: an envelope-only definition still gets a role", () => {
  const dir = project({
    ".freecode/agents/bare.md":
      "---\nname: bare\ndescription: Nothing but an envelope\nenvelope:\n  operations: [file.read]\n  read: [\"**\"]\n---\n",
  });
  try {
    const spawn = resolveSpawn({ subagent_type: "bare" }, dir);
    assert.ok(spawn && "role" in spawn, "resolved");
    const role = spawn.role;
    assert.ok(role, "no prompt and no allowlist, but the envelope is the role");
    assert.deepEqual(role.envelope?.read, ["**"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scopes: a definition refused for its envelope does not shadow a lower one", () => {
  const h = mkdtempSync(join(tmpdir(), "freecode-agent-defs-env-"));
  mkdirSync(join(h, ".freecode", "agents"), { recursive: true });
  writeFileSync(
    join(h, ".freecode", "agents", "scout.md"),
    "---\nname: scout\ndescription: user scout\ntools: Read\n---\nUser.",
  );
  const dir = project({
    ".freecode/agents/scout.md":
      "---\nname: scout\ndescription: project scout\ntools: Read\nenvelope:\n  operations: [file.write]\n---\nProject.",
  });
  try {
    const { definitions } = loadAgentDefinitions({ projectPath: dir, knownTools: KNOWN, homeDir: h, env: {} });
    const scout = definitions.find((d) => d.name === "scout");
    assert.equal(scout?.scope, "user");
    assert.equal(scout?.description, "user scout");
  } finally {
    rmSync(h, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("frontmatter: a block-form child does not swallow its siblings", () => {
  const sibling = parseFrontmatter('---\nenvelope:\n  read:\n    - "**"\n  write: [docs/**]\n---\n');
  assert.deepEqual(sibling?.fields, { envelope: { read: ["**"], write: ["docs/**"] } });
  const boolean = parseFrontmatter('---\nenvelope:\n  read:\n    - "**"\n  shell: true\n---\n');
  assert.deepEqual(boolean?.fields, { envelope: { read: ["**"], shell: "true" } });
  const both = parseFrontmatter('---\nenvelope:\n  read:\n    - docs/**\n  write:\n    - "**"\n---\n');
  assert.deepEqual(both?.fields, { envelope: { read: ["docs/**"], write: ["**"] } });
});

test("a nested block where a tool allowlist belongs is refused, not read as no allowlist", () => {
  assert.equal(
    parseAgentFile("---\nname: m\ndescription: d\ntools:\n  Read: true\n---\n", "/x/m.md", "user", KNOWN),
    null,
  );
});
