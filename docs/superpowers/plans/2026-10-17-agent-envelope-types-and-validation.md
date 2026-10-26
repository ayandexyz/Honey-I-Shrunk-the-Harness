# Agent Envelope: Types and Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent definition file can declare a capability `envelope:`, and a definition whose envelope is incomplete or contradictory is refused at load rather than loaded with half a grant.

**Architecture:** The documented format is nested YAML (`envelope:` then indented keys), and `agent/definitions/loader.ts`'s frontmatter reader only understands flat keys today, so it learns one level of nesting first. A new pure `agent/definitions/envelope.ts` then turns a parsed block into an `AgentEnvelope` or an `{ error }` naming the first thing wrong; `parseAgentFile` warns and skips the definition on error. The envelope rides on `AgentDefinition` and `AgentRole`; enforcement and shell containment were implemented in the follow-up `permission/` and `sandbox/` slices.

**Tech Stack:** TypeScript (Node ≥22, ESM, `.js` import suffixes), `node:test` + `tsx --test`, pnpm monorepo.

**Spec:** `docs/specs/2026-09-27-agent-control-and-definitions.md` §5 (Phase 5 — the capability envelope), especially §5.2, §5.3, §5.8 and §5.9. The priority plan's §6 records the resulting enforcement and sandbox as implemented. Read the spec first.

## Global Constraints

- No `envelope:` key ⇒ today's behaviour exactly: same fields, same roster line, same tools, same spawn.
- A definition with a bad envelope is **skipped with a warning naming the error**, never loaded with the envelope silently dropped — dropping it would run without the containment the file asks for (spec §5.8).
- Claude Code's `.claude/agents/*.md` files keep loading unchanged: flat keys, comma lists, block lists, `model` aliases, `mode` inference.
- Only `agent/definitions/loader.ts`'s copy of `parseFrontmatter` changes. `skills/loader.ts` and `commands/loader.ts` have independent copies and are not touched.
- Operations come from `tools/tool.types.ts`: its `PermissionOperation` union becomes derived from a runtime list, so there is exactly one vocabulary. `permission/profiles.ts` held its own **duplicate** `PermissionOperation` (line 205) and a stale `TOOL_PERMISSIONS` map; both were left alone here (that file was deleted 2026-10-17, spec §5.2 — done) and nothing here imported from it.
- `grants` entries validate against `knownTools`, plus any name starting `mcp__`. The MCP registry is empty at load time (MCP tools register dynamically), so a server's existence is deferred to execution.
- The loader stays synchronous and uncached.
- Each task ends green: `cd apps/core && FREECODE_EDIT_DIAGNOSTICS=0 npx tsx --test <file>` and `npx tsc --noEmit`.
- Commit on the current branch (`0.47.0`) only. Never push.
- No paid run: this slice changes no default behaviour, so no `pnpm eval` is owed (spec §5.9).

## Review Focus

1. **A Claude Code file with an indented list under a bare key** (`skills:` then `- x`): must still parse as a list, since the same syntax now means "map" when the children are `key: value` lines. Task 1.
2. **A glob containing a comma in an inline list** (`write: [docs/a,b.md]`): silently becomes two roots. The one real trap in this format; pin the block-form workaround as a documented limitation. Task 1.
3. **A root written `/etc/hosts`** instead of `//etc/hosts`: must be refused, because the path matcher would read it as project-relative and silently match nothing. Task 2.
4. **An envelope-only definition** (no `prompt`, no `tools`): must still produce a role, or the envelope vanishes before the loop ever sees it. Task 3.
5. **A definition skipped for a bad envelope must not shadow**: a same-named definition in a lower scope stays live. Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/core/src/agent/definitions/loader.ts` (modify) | One level of frontmatter nesting; call `parseEnvelope`; skip on error; document `envelope:` in the header |
| `apps/core/src/agent/definitions/envelope.ts` (new) | `parseEnvelope(value, knownTools)`: the whole validation vocabulary in one pure function |
| `apps/core/src/agent/definitions/envelope.test.ts` (new) | Accepted shapes, every refusal, and the loader's skip path |
| `apps/core/src/agent/definitions/types.ts` (modify) | `AgentEnvelope`; `AgentDefinition.envelope`; `AgentRole.envelope` |
| `apps/core/src/agent/definitions/resolve.ts` (modify) | Carry the envelope onto the role; an envelope alone is reason enough to have a role |
| `apps/core/src/agent/definitions/definitions.test.ts` (modify) | Parser nesting tests; resolve + scope tests |
| `apps/core/src/tools/tool.types.ts` (modify) | `PERMISSION_OPERATIONS` runtime list; `PermissionOperation` derived from it |
| `docs/specs/2026-09-27-agent-control-and-definitions.md` (modify) | Record the absolute-root refusal in §5.3 |
| `docs/2026-10-15-priority-implementation-plan.md` (modify) | Delete the delivered phase; renumber |

Deliberately **not** in this slice: showing the envelope in `freecode agents list`. Enforcement, sandboxing, and deletion of the obsolete permission profile map landed in follow-up slices.

---

### Task 1: One level of frontmatter nesting

**Files:**
- Modify: `apps/core/src/agent/definitions/loader.ts:30-62` (`parseFrontmatter`, `asList`)
- Test: `apps/core/src/agent/definitions/definitions.test.ts` (append)

**Interfaces:**
- Produces: `export type FrontmatterValue = string | string[] | Record<string, string | string[]>`
- Produces: `parseFrontmatter(text: string): { fields: Record<string, FrontmatterValue>; body: string } | null` (signature unchanged, value type widened)

- [x] **Step 1: Write the failing tests**

Append to `apps/core/src/agent/definitions/definitions.test.ts`:

```ts
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
```

- [x] **Step 2: Run them to verify they fail**

Run: `cd apps/core && FREECODE_EDIT_DIAGNOSTICS=0 npx tsx --test src/agent/definitions/definitions.test.ts`
Expected: FAIL on the three map cases — an indented `key: value` line matches nothing today, so `envelope` comes back as `[]` instead of a map. The other two (list stays a list, comma split) are regression guards and already pass.

- [x] **Step 3: Rewrite the parser loop**

In `parseFrontmatter`, keep the existing `FRONTMATTER` split, comment stripping and `unquote`, and replace the body loop with two pieces of state — the open top-level key and, inside it, the open child key — and this decision table:

| Line | Rule |
|---|---|
| indent 0, `key: value` | as today: string, inline list, or `key:` → `[]` with the kind still undecided |
| indent > 0, `- item` | into the open child when the item is indented deeper than it; else, if the kind is undecided or already a **list**, extend the list and push; else ignore |
| indent > 0, `child: value` | deeper than the open child → ignore; otherwise it is a sibling: if the kind is undecided, decide **map** (`fields[open.key] = {}`) and apply the child; if the kind is map, close the open child and apply this one |
| `child:` with no value | `map[child] = []`, remember it as the open child *and its indent*, so only deeper `- item` lines land there |
| anything else (deeper, or the wrong kind for the open key) | ignore, as the parser already does |

Blank lines never close a block. Indentation is measured: a child key owns the
lines deeper than itself, and a `child: value` at the child's own indent closes it
and starts the next — without that, every sibling after a block-form child would
be swallowed and its items absorbed into the previous axis. This keeps every file
that parses today parsing the same way; only indented `key: value` changes
meaning, from ignored to nested.

Also widen the parameter type of **both** helpers to `FrontmatterValue | undefined`. Only `asList`'s body changes, because a nested block reaching it is a type error otherwise:

```ts
function asList(v: FrontmatterValue | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : undefined;
  return list?.map((t) => t.trim()).filter(Boolean);
}
```

`asString`'s body already returns `undefined` for a non-string, so widening its parameter is the whole change there. Let the type errors on `v.split` drive this rather than casting them away.

- [x] **Step 4: Run them to verify they pass**

Run: `cd apps/core && FREECODE_EDIT_DIAGNOSTICS=0 npx tsx --test src/agent/definitions/definitions.test.ts`
Expected: PASS, including the file's existing frontmatter and roster tests.

- [x] **Step 5: Typecheck**

Run: `cd apps/core && npx tsc --noEmit`
Expected: no errors.

- [x] **Step 6: Commit**

```bash
git add apps/core/src/agent/definitions/loader.ts apps/core/src/agent/definitions/definitions.test.ts
git commit -m "feat(agents): read one level of nesting in agent definition frontmatter"
```

---

### Task 2: Parse and validate the envelope

**Files:**
- Modify: `apps/core/src/tools/tool.types.ts:36-44`
- Modify: `apps/core/src/agent/definitions/types.ts`
- Modify: `apps/core/src/agent/definitions/loader.ts` (call it; header comment)
- Create: `apps/core/src/agent/definitions/envelope.ts`
- Test: `apps/core/src/agent/definitions/envelope.test.ts`

**Interfaces:**
- Consumes: `FrontmatterValue`, `parseFrontmatter`, `parseAgentFile` (Task 1)
- Produces: `PERMISSION_OPERATIONS` (readonly array, 8 values) in `tools/tool.types.ts`, with `PermissionOperation` derived from it (the union is unchanged)
- Produces: `AgentEnvelope` in `definitions/types.ts`:
  ```ts
  export interface AgentEnvelope {
    operations: PermissionOperation[];
    read?: string[];
    write?: string[];
    network?: boolean;
    shell?: boolean;
    grants?: string[];
  }
  ```
- Produces: `AgentDefinition.envelope?: AgentEnvelope`
- Produces: `parseEnvelope(value: FrontmatterValue, knownTools: ReadonlySet<string>): AgentEnvelope | { error: string }`

- [x] **Step 1: Write the failing tests**

Create `apps/core/src/agent/definitions/envelope.test.ts`:

```ts
// =============================================================================
// The capability envelope: an agent definition's `envelope:` block, and the
// definition it refuses. Enforcement is covered by the follow-up envelope and
// sandbox slices — this file pins
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
    'envelope.operations has an unknown operation "file.nuke"',
  ],
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
```

- [x] **Step 2: Run them to verify they fail**

Run: `cd apps/core && FREECODE_EDIT_DIAGNOSTICS=0 npx tsx --test src/agent/definitions/envelope.test.ts`
Expected: FAIL — `./envelope.js` does not exist.

- [x] **Step 3: Add the runtime operation list**

In `apps/core/src/tools/tool.types.ts`, replace the hand-written union with a list and derive the type from it, so validation and the type cannot drift:

```ts
export const PERMISSION_OPERATIONS = [
  "file.read",
  "file.write",
  "file.delete",
  "network",
  "shell",
  "subprocess",
  "mcp",
  "agent.spawn",
] as const;

export type PermissionOperation = (typeof PERMISSION_OPERATIONS)[number];
```

- [x] **Step 4: Add the type**

In `apps/core/src/agent/definitions/types.ts`, add `AgentEnvelope` (above) importing `PermissionOperation` from `../../tools/tool.types.js`, and `envelope?: AgentEnvelope` on `AgentDefinition` with a comment pointing at the spec (§5.3: closed — what it does not name is denied).

- [x] **Step 5: Write `parseEnvelope`**

Create `apps/core/src/agent/definitions/envelope.ts` with the header comment style of its neighbours and this order of checks, first failure winning:

1. value is not a `Record` (a string or an array) → `envelope must be a block, not a value`
2. a key outside `operations`, `read`, `write`, `network`, `shell`, `grants` → `envelope has an unknown key "<key>"`
3. `operations` absent, not a list, or empty → `envelope.operations must list at least one operation`
4. an entry not in `PERMISSION_OPERATIONS` → `envelope.operations has an unknown operation "<op>"`
5. each of `read` and `write`, if present: an entry that is blank after `trim()` → `envelope.<axis> has an empty root`; an entry starting with `/` but not `//` → `envelope.<axis> root "<root>" is absolute; write "//<rest>" for an absolute path`
6. `file.read` present without a non-empty `read` → `envelope grants file.read but has no read roots`; `file.write` or `file.delete` without a non-empty `write` → `envelope grants file.write but has no write roots` (naming whichever of the two was granted)
7. `network` or `shell` present and not exactly `"true"`/`"false"` → `envelope.<axis> must be true or false`; otherwise the boolean
8. a `grants` entry that is not in `knownTools` and does not start with `mcp__` → `envelope.grants has an unknown tool "<name>"`

Return the assembled object with only the keys the definition actually declared. Note in a comment why step 8 defers MCP existence: the registry is empty at load time.

- [x] **Step 6: Call it from `parseAgentFile`**

After the `mode` block, before the return:

```ts
const rawEnvelope = fields.envelope;
let envelope: AgentEnvelope | undefined;
if (rawEnvelope !== undefined) {
  const parsed = parseEnvelope(rawEnvelope, knownTools);
  if ("error" in parsed) {
    logger.warn(`[agents] ${file}: ${parsed.error}, skipped`);
    return null;
  }
  envelope = parsed;
}
```

Import `AgentEnvelope` from `./types.js`, add `envelope` to the returned definition (`{ name, description, prompt: body, tools, model, mode, scope, location: file, envelope }` — `undefined` when the file declares none, which keeps "no key ⇒ unchanged" true), and document the key in the file's header comment (a fourth frontmatter example line, with the spec reference).

- [x] **Step 7: Run them to verify they pass**

Run: `cd apps/core && FREECODE_EDIT_DIAGNOSTICS=0 npx tsx --test src/agent/definitions/envelope.test.ts`
Expected: PASS (13 refusal cases + 3 others).

- [x] **Step 8: Typecheck and run the neighbours**

Run: `cd apps/core && npx tsc --noEmit && FREECODE_EDIT_DIAGNOSTICS=0 npx tsx --test src/agent/definitions/definitions.test.ts src/agent/definitions/envelope.test.ts`
Expected: no errors, all pass. The union's *shape* is unchanged, so the `tsc` run is what proves no tool that declares operations changed meaning; the full `pnpm -C apps/core test` is the branch's final gate, not this step's.

- [x] **Step 9: Commit**

```bash
git add apps/core/src/tools/tool.types.ts apps/core/src/agent/definitions/{types.ts,envelope.ts,envelope.test.ts,loader.ts}
git commit -m "feat(agents): parse and validate an agent definition's capability envelope"
```

---

### Task 3: Carry the envelope onto the spawn's role

**Files:**
- Modify: `apps/core/src/agent/definitions/types.ts` (`AgentRole`)
- Modify: `apps/core/src/agent/definitions/resolve.ts:60-66`
- Test: `apps/core/src/agent/definitions/definitions.test.ts` (append)

**Interfaces:**
- Consumes: `AgentEnvelope`, `AgentDefinition.envelope` (Task 2)
- Produces: `AgentRole.envelope?: AgentEnvelope`

- [x] **Step 1: Write the failing tests**

Append to `apps/core/src/agent/definitions/definitions.test.ts`:

```ts
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
```

- [x] **Step 2: Run them to verify they fail**

Run: `cd apps/core && FREECODE_EDIT_DIAGNOSTICS=0 npx tsx --test src/agent/definitions/definitions.test.ts`
Expected: FAIL on the first two (`role.envelope` is `undefined`; `bare` has no role) and PASS on the third (the loader already skips).

- [x] **Step 3: Carry it**

Add `envelope?: AgentEnvelope` to `AgentRole` in `types.ts`, and in `resolve.ts` include the envelope in the role **and** count it as a reason to have one:

```ts
const has = definition.prompt || definition.tools || definition.envelope;
const role = has
  ? { name: definition.name, prompt: definition.prompt, tools: definition.tools, envelope: definition.envelope }
  : undefined;
```

- [x] **Step 4: Run them to verify they pass**

Run: `cd apps/core && FREECODE_EDIT_DIAGNOSTICS=0 npx tsx --test src/agent/definitions/definitions.test.ts`
Expected: PASS, including the file's existing resolve and loop tests.

- [x] **Step 5: Typecheck**

Run: `cd apps/core && npx tsc --noEmit`
Expected: no errors.

- [x] **Step 6: Commit**

```bash
git add apps/core/src/agent/definitions/{types.ts,resolve.ts,definitions.test.ts}
git commit -m "feat(agents): carry the envelope onto a spawn's role"
```

---

### Task 4: Record the rule and close the phase

**Files:**
- Modify: `docs/specs/2026-09-27-agent-control-and-definitions.md` (§5.3)
- Modify: `docs/2026-10-15-priority-implementation-plan.md` (§6)

- [x] **Step 1: Record the refusal the code now makes**

In §5.3's roots bullet, add one sentence: a root beginning with a single `/` is refused with a hint to write `//`, because the path matcher reads a bare leading slash as project-relative and the rule would silently match nothing.

- [x] **Step 2: Delete the delivered phase**

In `docs/2026-10-15-priority-implementation-plan.md` §6, delete phase 1 ("Add the envelope to user-defined agent types and validation without changing defaults") and renumber the remaining three. Completed items are removed, not ticked.

- [x] **Step 3: Run the branch gate**

Run: `cd apps/core && npx tsc --noEmit && pnpm test`
Expected: no type errors; every `apps/core` test passes (this is the slice's final gate, and the only place the whole suite runs).

- [x] **Step 4: Commit**

```bash
git add docs/specs/2026-09-27-agent-control-and-definitions.md docs/2026-10-15-priority-implementation-plan.md
git commit -m "docs: record the envelope's absolute-root refusal, drop the delivered phase"
```
