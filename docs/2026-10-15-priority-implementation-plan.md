# Priority Implementation Plan

> **Status:** Active — completed slices removed
> **Date:** 2026-10-15
> **Last updated:** 2026-10-18
> **Scope:** Measurement follow-through and instruction hierarchy. Memory
> expansion and subagent permission scoping are resolved and summarized below.
> **Explicitly excluded:** Web/Tauri incremental response rendering.

## 1. Objective

Resolve the highest-value correctness, release-trust, and safety gaps before
adding broad new features, then establish the measurements needed to make
performance and cost changes safely.

This plan is deliberately split into reviewable workstreams. Performance and
cost work must start with measurement. Instruction hierarchy is the next
extensibility feature after those foundations are trustworthy.

## 2. Priority order

| Order | Workstream                            | Why it is here                                                                                                         |
| ----- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1     | Finish measurement follow-through     | The long-task comparison baseline still needs a publishable rerun before any optimization claim.                       |
| 2     | Add an instruction hierarchy          | Implemented 2026-10-17; retain the verification/evidence notes below for follow-up.                                    |

Workstream 1 should begin before any optimization experiment.

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

## 6. Resolved: scoped permissions for writable subagents

Closed and removed from the active queue on 2026-10-18; `ROADMAP.md` records
it as resolved. Enforcement is live end to end: an agent definition's
`envelope:` block narrows path, network, shell, and subprocess authority on
top of the existing mode + tool-allowlist + permission-rules pipeline (one
pure predicate, both call sites, parent ∩ child intersection on every spawn,
a denial landing in `function.denied` with source `envelope`). The sandbox
half (`apps/core/src/sandbox/`, built 2026-10-17) jails a granted `shell` to
the envelope's write roots — `/` read-only, write roots bind-mounted
read-write, `$HOME`/`/tmp` private, `--unshare-net` when `network: false` —
so a background shell or a `cd` out of the roots is bounded by the mount
layout, not by a tool's self-declaration. A write root the planner cannot
represent as a mount boundary fails closed rather than widening to its
parent, and `shell` is denied outright where no sandbox exists. The retired
`permission/profiles.ts` (`TOOL_PERMISSIONS`, `PROFILES`, `PermissionChecker`)
is deleted; nothing in `apps/core/src` references it.

Acceptance gate, verified by test: a writable subagent confined to directory A
cannot `shell` into B or background a shell there (`sandbox/plan.test.ts`,
"writes land on the write roots and nowhere else"); a network-disabled
subagent cannot reach the network through `shell` ("network: false isolates
the sandbox"); a child cannot request broader authority than its parent
(`permission/envelope.test.ts`, "an uncontained root is dropped", operations
and grants intersect); read-only defaults and existing definition tool
allowlists stay compatible; an unknown dynamic tool with no boundable target
or no declared operations fails closed and needs an explicit grant. Test
counts: `permission/envelope.test.ts` + `sandbox/*.test.ts` +
`evaluate.test.ts` 100/100, `agent/definitions/{envelope,definitions}.test.ts`
37/37, all passing on this branch.

One bound is a recorded, permanent exception rather than a gap: a mount
namespace constrains the sandboxed process, not FreeCode's own, so a
**granted** MCP tool still reaches its server's network under
`network: false` (spec §5.6). A grant is the user's explicit exception — the
operation list never claimed to bound a target that cannot be inspected — so
grants are not reinterpreted as "all MCP denied when offline." Stronger MCP
isolation needs per-tool capability metadata or a separate process, not a
mount, and is out of scope here.

Reference: `docs/specs/2026-09-27-agent-control-and-definitions.md` §5.

## 7. Workstream 2 — instruction hierarchy — implemented 2026-10-17

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

The subagent capability-envelope (formerly PR D) and instruction hierarchy
(formerly PR E) have both landed as separately gated phases; only PR A
remains open.

## 9. Definition of done

This plan is complete when:

- the repaired long-task benchmark has replaced the broken-tool baseline;
- memory merges cannot silently discard taught facts — done, §5;
- writable subagents can be constrained by path and network without gaining
  authority through dynamic tools — done, §6;
- monorepo, imported, and scoped instructions have deterministic, observable
  behavior — done, §7; and
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
