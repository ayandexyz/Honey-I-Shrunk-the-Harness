// =============================================================================
// The capability envelope: an agent definition's `envelope:` block, and the
// definition it refuses. Nothing enforces the envelope yet — this file pins
// what is accepted and the exact reason everything else is not.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";

const { parseEnvelope } = await import("./envelope.js");
const { parseAgentFile } = await import("./loader.js");
type FrontmatterValue = import("./loader.js").FrontmatterValue;

const KNOWN = new Set(["read", "grep", "glob", "ls", "write", "edit", "bash", "lsp", "memory"]);

test("envelope: the spec's example parses to exactly what it says", () => {
  assert.deepEqual(
    parseEnvelope(
      {
        operations: ["file.read", "file.write", "mcp"],
        read: ["**"],
        write: ["docs/**", "README.md"],
        network: "false",
        shell: "false",
        grants: ["mcp__linear", "lsp"],
      },
      KNOWN,
    ),
    {
      operations: ["file.read", "file.write", "mcp"],
      read: ["**"],
      write: ["docs/**", "README.md"],
      network: false,
      shell: false,
      grants: ["mcp__linear", "lsp"],
    },
  );
});

const refusals: Array<[string, FrontmatterValue, string]> = [
  ["a bare value", "false", "envelope must be a block, not a value"],
  ["an empty block", [], "envelope must be a block, not a value"],
  ["no operations", { read: ["**"] }, "envelope.operations must list at least one operation"],
  [
    "an unknown operation",
    { operations: ["file.nuke"] },
    'envelope.operations has an unknown operation "file.nuke"; valid: file.read, file.write, file.delete, network, shell, subprocess, mcp, agent.spawn',
  ],
  ["a scalar operations", { operations: "file.read" }, "envelope.operations must be a list"],
  ["a scalar read", { operations: ["file.read"], read: "**" }, "envelope.read must be a list"],
  [
    "a nested block where read belongs",
    { operations: ["file.read"], read: { a: "b" } },
    "envelope.read must be a list",
  ],
  ["a scalar grants", { operations: ["shell"], grants: "lsp" }, "envelope.grants must be a list"],
  ["read with no roots", { operations: ["file.read"] }, "envelope grants file.read but has no read roots"],
  ["write with no roots", { operations: ["file.write"] }, "envelope grants file.write but has no write roots"],
  ["delete with no write roots", { operations: ["file.delete"] }, "envelope grants file.delete but has no write roots"],
  [
    "an unknown key",
    { operations: ["shell"], writes: ["docs/**"] },
    'envelope has an unknown key "writes"',
  ],
  ["a non-boolean network", { operations: ["shell"], network: "yes" }, "envelope.network must be true or false"],
  ["a non-boolean shell", { operations: ["network"], shell: "1" }, "envelope.shell must be true or false"],
  ["an unknown grant", { operations: ["shell"], grants: ["ghost"] }, 'envelope.grants has an unknown tool "ghost"'],
  [
    "an absolute root",
    { operations: ["file.read"], read: ["/etc/hosts"] },
    'envelope.read root "/etc/hosts" is absolute; write "//etc/hosts" for an absolute path',
  ],
  ["an empty root", { operations: ["file.read"], read: [""] }, "envelope.read has an empty root"],
];

for (const [what, value, error] of refusals) {
  test(`envelope: ${what} is refused`, () => {
    assert.deepEqual(parseEnvelope(value, KNOWN), { error });
  });
}

test("envelope: a definition with a bad envelope is skipped, not loaded without it", () => {
  assert.equal(
    parseAgentFile(
      "---\nname: broken\ndescription: d\ntools: Read\nenvelope:\n  operations: [file.read]\n---\nBody.",
      "/x/broken.md",
      "project",
      KNOWN,
    ),
    null,
  );
});

test("envelope: a definition that declares one keeps it", () => {
  const def = parseAgentFile(
    "---\nname: doc\ndescription: d\ntools: Read, Write\nenvelope:\n  operations: [file.read, file.write]\n  read: [\"**\"]\n  write: [docs/**]\n---\nBody.",
    "/x/doc.md",
    "project",
    KNOWN,
  );
  assert.deepEqual(def?.envelope, {
    operations: ["file.read", "file.write"],
    read: ["**"],
    write: ["docs/**"],
  });
});

test("envelope: a block-form axis with sibling keys after it loads whole", () => {
  const def = parseAgentFile(
    "---\nname: blocky\ndescription: d\ntools: Read, Write\nenvelope:\n  operations: [file.read, file.write, shell]\n  read:\n    - \"**\"\n  write:\n    - docs/**\n  shell: true\n  grants:\n    - lsp\n---\nBody.",
    "/x/blocky.md",
    "project",
    KNOWN,
  );
  assert.deepEqual(def?.envelope, {
    operations: ["file.read", "file.write", "shell"],
    read: ["**"],
    write: ["docs/**"],
    shell: true,
    grants: ["lsp"],
  });
});
