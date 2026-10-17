# Priority Implementation Plan

> **Status:** Active — completed slices removed
> **Date:** 2026-10-15
> **Last updated:** 2026-10-18
> **Scope:** Memory expansion, subagent permission scoping, performance and cost
> measurement, and instruction hierarchy.
> **Explicitly excluded:** Web/Tauri incremental response rendering.

## 1. Objective

Resolve the highest-value correctness, release-trust, and safety gaps before
adding broad new features, then establish the measurements needed to make
performance and cost changes safely.

This plan is deliberately split into reviewable workstreams. Subagent
permissions require evidence and design work before implementation.
Performance and cost work must start with measurement. Instruction hierarchy is
the next extensibility feature after those foundations are trustworthy.

## 2. Priority order

| Order | Workstream                            | Why it is here                                                                                                         |
| ----- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1     | Finish measurement follow-through     | The long-task comparison baseline still needs a publishable rerun before any optimization claim.                       |
| 2     | Scope writable subagents              | Read-only subagents are confined, but writable subagents lack path and network boundaries.                             |
| 3     | Add an instruction hierarchy          | Implemented 2026-10-17; retain the verification/evidence notes below for follow-up.                                    |

Workstream 1 should begin before any optimization experiment. Workstreams 2–4
each require their own design or spec amendment and should not be combined into
one implementation PR.

## 3. Architectural constraints

- Business logic remains in `apps/core`; frontends only present state and call
  the shared backend.
- Memory consolidation must never delete source memories unless a durable
  replacement has been accepted. A syntactically valid but semantically lossy
  merge is not success.
- Subagent restrictions should reuse the live permission rules and mode-policy
  path. Do not enable the parallel, incomplete permission-profile map as-is.
- Optimization work must report end-to-end task cost and quality, not only
  local token, latency, or cache metrics.
- Instruction loading must preserve deterministic precedence and prompt-cache
  stability. Dynamic, file-scoped guidance belongs outside stable cache anchors
  unless its inclusion is fixed for the session.
- Paid eval commands require the operator procedure in `EVAL.md`. Agent
  comparison commands follow `AGENT-BENCH.md`, not `pnpm eval`.
- Rollout and OTLP events remain body- and path-free. Better observability means
  safe counts, identifiers, and attribution, not logging user content.

## 4. Workstream 1 — measurement follow-through

This workstream blocks claims that an optimization is faster or cheaper. It
does not block independent correctness fixes.

### 4.1 Re-establish the long-task baseline

Make the long-task comparison baseline publishable: fix the contamination window
for `minimax/MiniMax-M3`, rerun, rejudge with the documented judge configuration,
and record the exact commit, model, and judge. The rerun in
`bench/agent-bench/results/pathology-commits-v3-rerun/` is not a usable baseline
yet — it records no contamination window and reports `publishable: false`. The
earlier v2 numbers are historical evidence, not a baseline: all 88 of their
`grep` calls failed.

**State as of 2026-10-17.** The rerun has happened: `pathology-commits-v4/` holds 9
trials (3 tasks × 3) of freecode v0.46.1 against `minimax/MiniMax-M3`, harness
head `12287ced`, isolation container, judged timeout 60 min/trial — 8 trials with
patches and one empty (`freecode__add-agent-control t1`, 4 s, exit 1). The
contamination window is fixed. **Judging is deliberately deferred**, so there are
still no publishable numbers: the first panel run scored every trial with one
judge (the pinned `gpt-5.5` is retired for this account, so all nine `judge-gpt`
calls failed) and the harness correctly reported `DEGRADED` /
`publishable: false` rather than a score. The id is fixed
(`bench/agent-bench/runner/judge.ts` → `gpt-5.6-luna`). To finish:

```
pnpm bench:judge bench/agent-bench/results/pathology-commits-v4 --panel --rejudge
```

Judging is resumable (trials are not). Record the setup table, per-task numbers,
judge config and a reproduce block in `2026-10-13-long-task-bench-results.md`,
noting that the gpt half of the panel is `gpt-5.6-luna` where v3-rerun used
`gpt-5.5`.

### 4.2 Measurement-gated optimization queue

Do not implement every candidate at once. Use the harness to admit one change at
a time:

1. **Project-instruction size:** this repository's selected root `CLAUDE.md` is
   now over 82 KB, roughly ten times the shipped base system prompt. Prototype a
   compact root guide plus topic documents only after real request attribution
   exists, and use eval A/B to prove required subsystem rules are still found.
2. **Operation-specific model and effort:** extraction, compaction, and
   verification may use different policies only after their full cost and
   fallback behavior are visible. Respect an explicit user selection unless a
   configured routing policy says otherwise.
3. **Selective tool results and repeat-work reduction:** target observed output
   families and repeated reads, not global compression. The previous blanket
   Bash-compression experiment increased total cost and must not be retried as
   an unmeasured default.

Each accepted optimization needs a recorded user-facing metric, local work
metric, correctness result, memory tradeoff, and full task-cost result.

### Acceptance gate

- Every experiment records its hypothesis, workload, result, and verdict.
- The long-task baseline uses a functioning tool image and records its exact
  commit, model, and judge.

## 5. Deferred memory expansion

The memory-fidelity workstream was completed and removed from the remaining
priority queue on 2026-10-18. Extraction now validates that proposals cover the
latest concrete anchors, preserves independent same-topic facts, refuses lossy
consolidation, and gives recalled lists/maps explicit assembly and unit guidance.

Evidence: `long-late-correction` improved 0/3 → 3/3 in report
`5d8a97e5-080e-4c98-be19-345271d88f68`; `long-incremental-assembly` improved
0/3 → 2/3 in `04a55941-40c5-4e38-8cf8-439781ac20d4`. In the remaining failed
trial all three regions and percentage values reached the generated files; the
model then treated percentage points as multipliers, so it was a coding error,
not fact loss. The fidelity acceptance itself was 3/3 facts surviving through
extraction, consolidation, retrieval, and rendering.

Verification: 274/274 memory tests; `bench:recall` remained recall@5 81.8%,
recall@10 86.4%, MRR 84.1%, nDCG@10 79.4%; `bench:inject` rendered recall
84.1%, zero gold dropped, mean block 1,993 B under the 2,048 B cap, and 12/12
lifecycle scenarios.

The following expansion work remains separate from the completed fidelity
slice:

- Add the VectorStore id-to-index map before larger corpora make full sync
  quadratic; retain rebuildability from the Markdown source of truth.
- Backfill archived sessions through a bounded, resumable, leased job rather
  than an unbounded startup scan.
- Consider progressive disclosure only as a measured read-path redesign. A
  navigational summary plus on-demand bodies may beat a byte cap, but it changes
  MCP/tool surfaces and prompt-cache behavior.

## 6. Workstream 3 — scoped permissions for writable subagents

### Current state

Read-only subagents use `explore` mode, which filters mutating tools and does not
prompt. Writable subagents can use a tool allowlist, but once a mutating tool is
allowed they inherit the parent's path and network reach.

### Design direction

Use one permission decision pipeline:

1. Agent mode supplies the coarse read-only/build boundary.
2. The agent definition supplies an optional tool allowlist.
3. A subagent capability envelope narrows the parent's authority with path,
   network, shell, and subprocess constraints.
4. Existing permission rules evaluate the concrete target and requested
   operation inside that envelope.
5. Child agents may only reduce, never expand, their parent's authority.

The operations a tool needs come from its own `permissions.operations` and its
target from `extractTarget` — there is no second map. The retired
`permission/profiles.ts` (`TOOL_PERMISSIONS`, `PROFILES`, `PermissionChecker`)
and its unreachable orchestrator branch are deleted.

### Phases

The specification is `docs/specs/2026-09-27-agent-control-and-definitions.md`
§5 — the envelope's semantics, precedence, MCP and inheritance rules, and the
questions its own §6 leaves open. Enforcement is live: one pure predicate, both
call sites, the parent ∩ child intersection on every spawn, the ceiling threaded
into the finish-gate spawn, and a denial that lands in `function.denied` with
source `envelope`.

The sandbox half of §5.5 is **built** (2026-10-17, `apps/core/src/sandbox/` —
one planner for enveloped shells and unattended night runs): a granted `shell`
runs with `/` read-only and only the envelope's write roots overlaid writable,
`$HOME` and `/tmp` private, and `--unshare-net` when `network: false`. So a
background shell and a `cd` out of the roots are bounded by the mount layout
rather than by a tool's declaration. A writable root the planner cannot represent
as a mount boundary fails closed instead of widening to its parent, and where no
sandbox exists `shell` is denied outright rather than run uncontained.

One bound this phase does **not** deliver, recorded in spec §5.6: a mount
namespace constrains the sandboxed process, not FreeCode's own, so a **granted**
MCP tool still reaches its server's network under `network: false`. A grant is
the user's explicit exception — the operation list never claimed to bound a
target that cannot be inspected — so grants are not reinterpreted as "all MCP
denied when offline". Stronger MCP isolation needs per-tool capability metadata
or a separate process, not a mount.

### Acceptance gate

- A writable subagent restricted to directory A cannot **shell** into directory B,
  and cannot background a shell there. (Writing, editing and `lsp` against B
  already fail: the root check refuses the target and `lsp` needs a grant plus
  `subprocess`.)
- A network-disabled subagent cannot reach the network through a **shell**
  (`--unshare-net`, proven in `sandbox/plan.test.ts`). Web tools already fail:
  `network: false` withholds the operation. A **granted** MCP tool is the explicit
  exception — its target cannot be inspected, and a mount namespace cannot bound a
  process outside the sandbox (spec §5.6).
- A child cannot request broader authority than its parent.
- Read-only defaults and existing definition tool allowlists remain compatible.
- Unknown dynamic tools fail closed with an actionable denial reason.

## 7. Workstream 4 — instruction hierarchy — implemented 2026-10-17

### Delivered behavior

`apps/core/src/context/instructions.ts` now loads global instructions followed
by repository ancestors from the repository boundary to the active project.
`CLAUDE.md` still wins over `AGENTS.md` within a directory. Explicit
`@import path` directives resolve relative to their source and are bounded by
the global or repository policy root, with real-path symlink checks, duplicate
suppression, a 16-level depth limit, 64 imported files, and a 1 MB imported
content budget. Missing or invalid imports are ignored without changing the
parent instruction.

`.freecode/rules/*.md` supports a small frontmatter form:

```md
---
globs: [src/**/*.ts]
---
Use the TypeScript conventions for this scope.
```

Matching rules are selected against the deterministic project file scope and
remain in the static, cacheable prompt prefix for the session. `/context`
reports each loaded source's path, kind, scope, byte count, and token estimate;
contents are never returned in the report.

### Decisions recorded by the implementation

- The active project anchors the walk; if it is inside a Git repository, the
  repository root is the boundary. A non-repository project keeps the old
  root-only behavior.
- Global instructions precede repository hierarchy. Ancestors are ordered root
  to leaf. `CLAUDE.md` wins within a directory; imports expand in place; scoped
  rules are sorted by filename after hierarchy instructions.
- Imports cannot leave their policy root, follow an escaping symlink, recurse
  indefinitely, or exceed the documented depth/file/byte limits.
- Scoped rules are frozen with the session's deterministic project scope and
  are visible in `/context` without exposing contents.

### Completed phases

1. **Walk-up hierarchy** — complete.
2. **Explicit imports** — complete.
3. **Glob-scoped rules** — complete.
4. **Observability** — complete.

### Verification

Automated coverage now includes root-to-leaf precedence, imports and outside
imports, scoped glob selection, escaping import symlinks, prompt segment
stability, and `/context` rendering. Focused tests and core/TUI typechecks pass.
The remaining follow-up is evidence rather than implementation: run the
cross-provider eval A/B across representative provider, memory, TUI, and
checkpoint tasks before making any further default-loading changes.

### Acceptance gate

- Monorepo packages receive their applicable instructions in deterministic
  order.
- Imports cannot escape policy boundaries or recurse indefinitely.
- Scoped rules activate only for matching work and their inclusion is visible
  in `/context`.
- Existing root-only projects keep the previous behavior unless they add
  ancestor instructions, imports, or `.freecode/rules/` files.

## 8. Delivery slices

Keep review and rollback simple:

- **PR A:** Rebuilt long-task baseline and recorded results; no behavioral
  change.
- **PR D:** Subagent capability-envelope spec and implementation.
- **PR E:** Instruction hierarchy in separately gated phases.

Do not combine the remaining permission and instruction changes. Each changes
what the model sees or what tools can do and therefore needs isolated evidence.

## 9. Definition of done

This plan is complete when:

- the repaired long-task benchmark has replaced the broken-tool baseline;
- memory merges cannot silently discard taught facts;
- writable subagents can be constrained by path and network without gaining
  authority through dynamic tools;
- monorepo, imported, and scoped instructions have deterministic, observable
  behavior; and
- every behavioral default change has the tests and eval evidence required by
  its governing spec.

## 10. References

- `docs/specs/2026-05-25-architecture-v4.md`
- `docs/specs/2026-07-18-permission-rules.md`
- `docs/specs/2026-07-27-tool-output-store.md`
- `docs/specs/2026-08-23-memory-consolidation.md`
- `docs/specs/2026-09-27-agent-control-and-definitions.md`
- `docs/specs/2026-09-23-checkpoints-rewind.md`
- `docs/specs/2026-09-25-memory-efficiency-and-graph-explorer.md`
- `docs/2026-10-11-performance-recommendations.md`
- `docs/2026-10-12-token-and-cost-efficiency.md`
- `docs/2026-10-13-long-task-bench-results.md`
- `apps/core/src/memory/bench/README.md`
- `ROADMAP.md`
- `TODO.md`
- `EVAL.md`
- `AGENT-BENCH.md`
- `TRACE.md`
