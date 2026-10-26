# Agent envelope — enforcement

**Spec:** `docs/specs/2026-09-27-agent-control-and-definitions.md` §5.3–§5.9.
**Priority plan item:** `docs/2026-10-15-priority-implementation-plan.md` §6 (implemented).
**Predecessor (built):** `docs/superpowers/plans/2026-10-17-agent-envelope-types-and-validation.md`
— `parseEnvelope`, `AgentEnvelope`, `AgentRole.envelope`, `AgentDefinition.envelope` all exist.

## Goal

A definition that declares `envelope:` is **actually contained** by it. This plan's
enforcement slice is implemented. An enveloped agent:

- is offered only tools whose declared operations the envelope grants,
- is refused at execution for a target outside its roots, by the same single
  `denyToolCall` exit every other refusal uses, with a readable reason,
- cannot escape by spawning: a child's ceiling is its own **intersected with the
  spawning loop's effective ceiling**, at every depth.

No `envelope:` key ⇒ today's behaviour exactly (§5.8).

## Scope

**In:** the predicate; the two call sites (§5.4); the effective-envelope plumbing into a
subagent's loop including parent ∩ child; the `"envelope"` deny source; deterministic
tests (§5.9).

**Out, deliberately:**

- Additional breadth coverage for extension tools / MCP beyond the implemented
  predicate and sandbox tests remains separate follow-up work.
- Loader warning on unknown top-level frontmatter keys (§6 Q9) — still open, not needed
  for enforcement.
- A bus event for a denial (§6 Q6) — phase 3.

## Rulings

These are decisions the spec left to the plan. Each is load-bearing; the reviewer should
read them before the code.

| # | Ruling | Why |
| - | ------ | --- |
| R1 | The four session-state tools are **exempt**: `todowrite`, `question`, `bashoutput`, `finish_iteration` (registered ids, `tools/*.ts`). Everything else that declares no operations is still denied unless granted. | User's answer to §6 Q11. Fixed name list, so a future tool is not swept in. These four reach nothing outside the session. |
| R2 | `network`/`shell` booleans **narrow only**. `resolveOperations()` removes the operation when the boolean is `false`; `true`/absent leaves the declared list alone. There is exactly one gate: the operation set. | §5.3's own example grants `mcp` while setting `network: false`; a boolean that could *grant* would contradict `operations` being the grant list. One gate means one reason string and no double-negative cases. |
| R3 | The agent family — `agent`, `agent_send`, `agent_stop` — is gated by its `agent.spawn` operation and is **not** the target-less case. | Its "target" is a subagent type an envelope cannot bound; requiring `grants: [agent]` *on top of* `agent.spawn` would make the operation meaningless. Everything else with no path/url/command target follows §5.6 literally and needs a grant: `lsp`, `memory`, `skill`, `output`, `killbash`, MCP tools, extension tools. That list is fail-closed; a grant is the documented escape hatch. |
| R4 | **Nesting lands in phase 1**, not phase 2: `loop.run` sets its effective envelope to `intersect(parentEffective, role.envelope)`, so the intersection holds at every depth. | Phase 2's "nested agents" wording assumes phase 1 already binds. Without the intersection, phase 1 ships a ceiling with a documented escape: an enveloped agent spawns a child whose envelope is wider than its own. Opt-in or not, that is the Critical a reviewer would rightly file. Phase 2 keeps the breadth (extension/MCP/background-shell coverage) that its wording also names. |
| R5 | Both `DenySource` (`rollout/types.ts`) and `PermissionEvaluation.source` (`permission/rule-types.ts`) gain `"envelope"`. The readable text rides a **new** optional `reason?: string` on `PermissionEvaluation`. | `matchedRule` is documented as "raw text of the rule that matched"; the envelope has no rule text, so reusing it would lie to the prompt at `loop.ts:3471`. |
| R6 | `evaluatePermission` receives the tool's declared operations as `EvaluateInput.operations`, supplied by its caller from the registry (`getTool(name)?.permissions?.operations ?? []`). It does **not** import the tool registry itself. | `permission/` must not import `tools/` at runtime: `tools/defs-cache.ts` and `tools/orchestrator.ts` already import `permission/`, so the reverse edge creates a cycle. An omitted/unknown tool yields `[]` ⇒ denied unless granted, which is fail-closed. `import type { PermissionOperation }` is erased and therefore fine. |
| R7 | Root containment in the intersection is **textual and fail-closed**: a child root survives only if it equals a parent root or starts with `parentRoot` with its trailing `/**` (or a `/`) normalised away. `parent: "**"` contains everything. | Deciding glob-language containment exactly is not worth it in v1. Textual containment can only *drop* a root, never invent one, so the failure mode is a child that is too narrow. Documented in the function's comment. |
| R8 | The tool-list filter prunes by operations **and** by the target-less-without-a-grant rule (both statically knowable from a name). Only the *path* check is skipped, because args do not exist yet. | §5.7 says filter-time pruning is silent by operation; pruning a target-less tool the envelope will never grant avoids offering the model a tool that is guaranteed to be refused. The path check cannot be done early and stays at the execution site, which §5.4 calls the authoritative gate. |
| R9 | A granted `lsp` still needs `subprocess` (§6 Q8): a grant exempts the target check "and nothing else" (§5.3). | The declaration says lsp spawns a process, and it does. `lsp` is grantable *and* needs its operations — two independent statements, both true. |

## Files

| File | Change |
| ---- | ------ |
| `apps/core/src/permission/rules.ts` | export `matchPath`; add `targetKind()` derived from the existing private sets |
| `apps/core/src/permission/envelope.ts` | **new** — the pure predicate, `resolveOperations`, `intersectEnvelopes`, the exemption list |
| `apps/core/src/permission/envelope.test.ts` | **new** — §5.9's unit matrix |
| `apps/core/src/permission/evaluate.ts` | step 0 before `danger`; `EvaluateInput.envelope` + `.operations` |
| `apps/core/src/permission/rule-types.ts` | `source` gains `"envelope"`; `reason?: string` |
| `apps/core/src/rollout/types.ts` | `DenySource` gains `"envelope"` |
| `apps/core/src/agent/types.ts` | `SessionState.envelope`, `UserInput.envelope` |
| `apps/core/src/tools/types.ts` | `ToolContext.envelope` |
| `apps/core/src/agent/loop.ts` | `run()` intersects; ctx carries it; the two call sites; the pipeline runs for an enveloped agent in `danger` mode |
| `apps/core/src/tools/agent.ts` | both `run()` sites pass `envelope: ctx.envelope` |
| `apps/core/src/agent/envelope-enforcement.test.ts` | **new** — loop-level deny/allow at the execution site |
| `apps/core/src/permission/evaluate.test.ts` | deny-before-danger cases |

New test files are `*.test.ts` next to their code, as AGENTS.md requires. Nothing here is
an eval case: §5.9 says the denial path is deterministic, so these tests carry it.

---

## Task 1 — the predicate

**Verify:** `cd apps/core && FREECODE_EDIT_DIAGNOSTICS=0 npx tsx --test src/permission/envelope.test.ts` green, `npx tsc --noEmit` clean.

### 1.1 `rules.ts`: export the two things the predicate needs

`PATH_TOOLS` (`rules.ts:19`), `URL_TOOLS` (`:20`) and `COMMAND_TOOLS` (`:15`) already encode the
tool families; do not restate them.

- `matchPath` (`rules.ts:117`) → `export function matchPath(...)`. Its `..`-rejection
  (`:132`) and absolute (`//`) handling are exactly what §5.3 asks roots to be read with.
- Add, next to `extractTarget`:

```ts
/** Which argument family a tool's target belongs to. `undefined` means the tool
 *  has no target an envelope can bound (spec §5.6), so it needs a grant. */
export function targetKind(
  toolName: string,
): "path" | "url" | "command" | "agent" | undefined {
  const tool = toolName.toLowerCase();
  if (PATH_TOOLS.has(tool)) return "path";
  if (URL_TOOLS.has(tool)) return "url";
  if (COMMAND_TOOLS.has(tool)) return "command";
  // The agent family is gated by its own `agent.spawn` operation (ruling R3).
  if (tool === "agent" || tool === "agent_send" || tool === "agent_stop") return "agent";
  return undefined;
}
```

### 1.2 `permission/envelope.ts` (new)

```ts
import type { AgentEnvelope } from "../agent/definitions/types.js";
import type { PermissionOperation } from "../tools/tool.types.js";
import { matchPath } from "./rules.js";

/** Ruling R1. */
export const ENVELOPE_EXEMPT_TOOLS = new Set([
  "todowrite", "question", "bashoutput", "finish_iteration",
]);

export interface EnvelopeQuery {
  envelope: AgentEnvelope;
  toolName: string;
  /** The tool's declared `permissions.operations`; `[]` when it declares none. */
  operations: readonly PermissionOperation[];
  kind: "path" | "url" | "command" | "agent" | "none";
  /** The call's target, at execution time only — the tool list has no args. */
  target?: string;
  projectRoot: string;
}

export type EnvelopeVerdict = { decision: "allow" } | { decision: "deny"; reason: string };

export function resolveOperations(envelope: AgentEnvelope): Set<PermissionOperation>;
export function envelopeDecision(query: EnvelopeQuery): EnvelopeVerdict;
export function intersectEnvelopes(
  parent: AgentEnvelope | undefined,
  child: AgentEnvelope | undefined,
): AgentEnvelope | undefined;
```

`envelopeDecision`, in this order (each step is one test group):

1. `ENVELOPE_EXEMPT_TOOLS.has(name)` → allow.
2. `granted = (envelope.grants ?? []).some(g => g.toLowerCase() === toolName.toLowerCase())`.
3. `operations.length === 0` → `granted ? allow : deny('this agent was not granted <tool>')`.
4. First declared operation missing from `resolveOperations(envelope)` → deny
   `tool <tool> needs the <op> operation; this agent's envelope allows: <ops|none>`.
5. `kind === "path"`:
   - `target === undefined` → allow (ruling R8: filter time).
   - axes = `file.read` present → read roots, `file.write`/`file.delete` present → write roots
     (both present ⇒ the union, per `file.delete` also needing `write` roots).
   - no axe's roots match `matchPath(root, target, projectRoot)` → deny
     `<axis> of <target> is outside this agent's <axis> roots (<roots|none>)` — §5.7's
     reason shape.
6. `kind === "none"` → `granted ? allow : deny('this agent was not granted <tool>')`.
7. `url` / `command` / `agent` → allow: v1 has no host or command allowlist (§5.3), so the
   operation gate in step 4 is the whole gate.

`resolveOperations` and `intersectEnvelopes`:

```ts
// R2: a boolean can only narrow. Undefined is "not narrowed".
const ops = new Set(envelope.operations);
if (envelope.network === false) ops.delete("network");
if (envelope.shell === false) ops.delete("shell");
```

```ts
// R4/R7. Undefined parent or child means "no ceiling from that side", so the
// other side's own envelope stands, unchanged.
if (!parent) return child;
if (!child) return parent;
return {
  operations: child.operations.filter((op) => parent.operations.includes(op)),
  read: containedOnly(parent.read, child.read),
  write: containedOnly(parent.write, child.write),
  network: parent.network === false || child.network === false ? false : undefined,
  shell: parent.shell === false || child.shell === false ? false : undefined,
  grants: child.grants?.filter((g) => parent.grants?.includes(g) ?? false),
};
```

`containedOnly(parentRoots, childRoots)` returns `undefined` for an undefined list;
otherwise `childRoots.filter(r => parentRoots.some(p => contains(p, r)))`, and `undefined`
when the result is empty (an empty root list is "no roots", which validation already
refuses for a granted path operation).

`contains(parentRoot, childRoot)` (R7): normalise `p = parentRoot.endsWith("/**") ?
parentRoot.slice(0, -3) : parentRoot`; true when `childRoot === p`, or
`childRoot.startsWith(p + "/")`, or `p === ""` (`parent: "**"`). Comment says textual +
fail-closed.

### 1.3 `permission/envelope.test.ts` (new)

Table-driven, one case per row. §5.9's matrix:

- **Operations** — each of `file.read, file.write, file.delete, network, shell, subprocess,
  mcp, agent.spawn` × granted / not granted. Not-granted asserts the reason names the
  operation.
- **Roots** — target inside a root; outside by absolute path (`/etc/hosts` with `read: ["//etc/hosts"]`
  and without); outside by `..` (`docs/../secret`); symlink (create a real symlink in a
  temp dir pointing outside the roots — assert denied, since `matchPath` resolves the
  path it is given, so the test pins that the *caller* passes the resolved path;
  `loop.ts` passes `extractTarget`, so also assert the raw `..` form is denied).
- **Below** — `docs/**` allows `docs/a/b.md` and `docs` itself.
- **Undeterminable** — `kind: "none"` denied without a grant, allowed with one; same for
  empty `operations`.
- **Exempt** — the four names allowed with an empty envelope body's worth of grants.
- **R2** — `network: false` with `network` in `operations` denies `webfetch`;
  `network: true` with `network` declared allows it.
- **Intersection** — parent/child both undefined → undefined; one side → that side;
  operations intersect; `read: ["docs/**"]` parent vs `read: ["docs/a/**"]` child survives,
  `read: ["**"]` child dropped; `network`/`shell` false wins on either side; grants
  intersect.

**Ledger line:** `Task 1 — predicate: permission/envelope.ts + rules.ts exports; 1 new test file, N cases green.`

---

## Task 2 — the execution site is authoritative

**Verify:** `cd apps/core && FREECODE_EDIT_DIAGNOSTICS=0 npx tsx --test src/permission/evaluate.test.ts src/agent/envelope-enforcement.test.ts` green, `npx tsc --noEmit` clean.

### 2.1 `permission/rule-types.ts`

`source` gains `"envelope"`; add `reason?: string` with a one-line comment (ruling R5).

### 2.2 `permission/evaluate.ts`

`EvaluateInput` gains `envelope?: AgentEnvelope` and `operations?: readonly PermissionOperation[]`
(default `[]` inside). Insert the envelope **as step 0**, above the danger bypass at `:25`,
using `targetKind(toolName)` and `extractTarget(toolName, args)` for the kind/target:

```ts
if (envelope) {
  const verdict = envelopeDecision({
    envelope, toolName, operations,
    kind: targetKind(toolName) ?? "none",
    target: extractTarget(toolName, args),
    projectRoot,
  });
  if (verdict.decision === "deny") {
    return { decision: "deny", source: "envelope", reason: verdict.reason };
  }
}
```

Its header comment (`evaluate.ts:1-5`) gains `envelope` at the front of the order line.

### 2.3 `rollout/types.ts`

`DenySource` gains `"envelope"` (the comment above it explains the "which gate" split; add
`envelope` there as "the agent's own declared ceiling, which outranks all of them").

### 2.4 `agent/loop.ts` — the permission block at `3383`

Today the whole pipeline sits inside `if (this.state.agentMode !== "danger")`. Restructure
so the **evaluator always runs** and only the hook/ask half stays behind the guard:

```ts
const evaluation = evaluatePermission({
  toolName: toolCall.tool,
  args,
  mode: this.state.agentMode,
  rules: this.permissionRules,
  projectRoot: this.state.projectPath,
  envelope: this.state.envelope,
  operations: getTool(toolCall.tool)?.permissions?.operations ?? [],
});
if (evaluation.decision === "deny") { /* existing deny mapping + unattended.record */ }
if (this.state.agentMode !== "danger") { /* existing hooks, ask, prompt half */ }
```

For a non-enveloped `danger` run the evaluator returns `allow`/`danger` immediately, so the
observable behaviour is unchanged — that is the point of the restructure, and the existing
danger tests must stay green. Add the deny mapping branch beside the existing
`mode`/`rule` split:

```ts
if (evaluation.source === "envelope") {
  return this.denyToolCall(
    toolCall, "envelope",
    evaluation.reason ?? `denied by the ${this.state.role?.name ?? "agent"}'s envelope`,
  );
}
```

### 2.5 Tests

`permission/evaluate.test.ts`:

- an envelope denial wins **in danger mode** (`mode: "danger"` + a write outside the roots →
  `{decision: "deny", source: "envelope"}`), because `danger` is the bypass the spec names.
- an in-envelope call in danger mode is still `allow`/`danger` (unchanged).
- no envelope → nothing changes for danger, plan and build.
- an unknown tool name (`operations` omitted) with an envelope → denied.

`agent/envelope-enforcement.test.ts` (new) — mirror `agent/loop-tracing.test.ts:92-122`'s
harness (scripted provider + `recorderFactory` into a temp `rolloutDir`) and
`agent/headless-permission.test.ts:71-115`'s scripted `write`:

- `role: {name, prompt, tools: ["write"], envelope: {operations: ["file.write"], write: ["docs/**"]}}`,
  the model writes `docs/a.md` → file exists, and no `function.denied`.
- same envelope, the model writes `../outside.txt` → file absent, and the rollout log holds
  `function.denied` with `source: "envelope"` and a reason naming the write roots.
- same envelope, the model calls `bash` → absent from the offered set is asserted by the
  denied event's reason (offered-set pruning is Task 3's test) and no shell runs.

**Ledger line:** `Task 2 — execution gate: evaluatePermission step 0 + danger restructure + envelope DenySource; 2 test files green.`

---

## Task 3 — plumbing and the tool-list filter

**Verify:** same commands over `src/agent/envelope-enforcement.test.ts`, `src/agent/envelope-nesting.test.ts`, plus the full suite (`FREECODE_EDIT_DIAGNOSTICS=0 pnpm test`).

### 3.1 types

- `agent/types.ts`: `SessionState.envelope?: AgentEnvelope` beside `role` (`:261`);
  `UserInput.envelope?: AgentEnvelope` beside `role` (`:325`), commented as "the spawning
  loop's effective envelope; intersected with `role.envelope`".
- `tools/types.ts`: `ToolContext.envelope?: AgentEnvelope`, commented like the neighbouring
  `agentMode` — "the spawning loop's effective ceiling; only the `agent` tool reads it".

### 3.2 `loop.run()` intersects (ruling R4)

```ts
role: input.role,
envelope: intersectEnvelopes(input.envelope, input.role?.envelope),
```

so a caller that passes only `role` still gets that definition's own ceiling enforced, and
a nested spawn narrows what it inherits. `createInitialSessionState` leaves it undefined.

### 3.3 the tool-list filter (`loop.ts:2691-2699`)

The allowlist filter stays; add the envelope after it, in the same expression:

```ts
const envelope = this.state.envelope;
let tools = allowed ? offered.filter((t) => allowed.includes(t.name)) : offered;
if (envelope) {
  tools = tools.filter(
    (t) =>
      envelopeDecision({
        envelope,
        toolName: t.name,
        operations: getTool(t.name)?.permissions?.operations ?? [],
        kind: targetKind(t.name) ?? "none",
        projectRoot: this.state.projectPath,
      }).decision === "allow",
  );
}
```

No `target` is passed (ruling R8) — the path check is the execution site's job. Import
`targetKind` from `permission/rules.js` and `envelopeDecision` from `permission/envelope.js`
(the loop already imports from both modules).

### 3.4 the tool context (`loop.ts:3525`)

`envelope: this.state.envelope,` beside `agentMode:`.

### 3.5 `tools/agent.ts`

Both `subAgentLoop.run({...})` sites pass `envelope: ctx.envelope` — the fresh spawn
(`:385`) and the continuation (`:179`/`:191` path, which spreads a saved config; add the
field to that spread). Nothing else changes: the child's own `role.envelope` is still
applied by the child's `run()`.

### 3.6 Tests — `agent/envelope-nesting.test.ts` (new)

- **Filter** — a scripted provider asked to call `bash` while the role's envelope grants
  only `file.read`: the provider's received tool list (capture it in the fake provider's
  `execute`) has no `bash`, and has `read` and `todowrite` (the exemption, R1). This is the
  offered-set assertion Task 2 deferred.
- **Intersection end to end** — parent loop with `envelope: {operations: [file.read,
  file.write, agent.spawn], read: ["**"], write: ["docs/**"], grants: ["agent"]}` spawns a
  child (scripted provider; `agent` tool path is not needed — call `loop.run` twice and
  hand the child `envelope: parent.state.envelope`) whose own envelope is
  `{operations: [file.write], write: ["**"]}`; the child's effective write roots are
  `docs/**`, so a child write to `outside.txt` is denied with `source: "envelope"`.
- **No widening** — the same child with `write: ["docs/a/**"]` and a requested parent
  `write: ["docs/**"]`: `docs/a/b.md` is allowed, `docs/b.md` is denied. Pins ruling R7.

**Ledger line:** `Task 3 — plumbing + filter + intersection; 2 test files green, full suite N/N.`

---

## Task 4 — docs

**Verify:** `grep -n "phase 1" docs/2026-10-15-priority-implementation-plan.md` shows the phase gone and the list renumbered.

- `docs/2026-10-15-priority-implementation-plan.md` §6: **delete** the phase-1 bullet
  (completed items are deleted, not ticked) and renumber; adjust phase 2's wording now that
  nesting shipped — it keeps built-ins, extension tools, MCP tools and background shells.
- `docs/specs/2026-09-27-agent-control-and-definitions.md`: §5.3 gains one sentence for R2
  ("a boolean can only narrow; the operation list is the grant"), §5.6's Q11 sentence
  resolves to the exemption (R1), §5.5's Q8 mention resolves (R9), and §6 Q8/Q11 are
  struck as decided.
- `AGENTS.md`: the envelope row, if it does not already say so, notes that enforcement is
  live and that the sandbox for a granted shell is not.

**Ledger line:** `Task 4 — docs: plan §6 phase 1 deleted + renumbered, spec §5.3/§5.6 + Q8/Q11 settled.`

---

## Acceptance gate (§5.9, priority plan §6)

After Task 4, all of these must hold, each covered by a named test above:

1. A spawn with `write: [docs/**]` writes inside and is denied outside by absolute path,
   `..`, and symlink. *(Task 2.5, Task 3.6)*
2. A child cannot request broader authority than its parent. *(Task 3.6)*
3. `lsp` and MCP are denied until granted, and a granted `lsp` still needs `subprocess`.
   *(Task 1.3, Task 2.5, R9)*
4. A definition with no `envelope:` behaves exactly as before. *(Task 2.5)*
5. A denial lands in `function.denied` with `source: "envelope"` and never in `toolSpans`.
   *(Task 2.5)*

Item 1's *shell* half ("cannot `cd` outside in a shell, cannot background a shell outside")
is implemented by the shared `apps/core/src/sandbox/` planner and its real bwrap
integration tests. The historical phase-2 deferral is closed.
