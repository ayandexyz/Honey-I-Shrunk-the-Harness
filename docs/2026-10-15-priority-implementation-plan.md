# Priority Implementation Plan

> **Status:** Active — completed slices removed
> **Date:** 2026-10-15
> **Last updated:** 2026-10-17
> **Scope:** Memory fidelity, subagent permission scoping, performance and cost
> measurement, and instruction hierarchy.
> **Explicitly excluded:** Web/Tauri incremental response rendering.

## 1. Objective

Resolve the highest-value correctness, release-trust, and safety gaps before
adding broad new features, then establish the measurements needed to make
performance and cost changes safely.

This plan is deliberately split into reviewable workstreams. Memory fidelity
and subagent permissions require evidence and design work before implementation.
Performance and cost work must start with measurement. Instruction hierarchy is
the next extensibility feature after those foundations are trustworthy.

## 2. Priority order

| Order | Workstream                            | Why it is here                                                                                                         |
| ----- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1     | Finish measurement follow-through     | The long-task comparison baseline still needs a publishable rerun before any optimization claim.                       |
| 2     | Diagnose and prevent memory fact loss | Existing long-horizon evidence shows missing and lost facts; new memory features should not be layered on top of that. |
| 3     | Scope writable subagents              | Read-only subagents are confined, but writable subagents lack path and network boundaries.                             |
| 4     | Add an instruction hierarchy          | This is the roadmap's highest-value remaining extensibility item and benefits from the measurement foundation.         |

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

## 5. Workstream 2 — memory fidelity before memory expansion

### Current evidence

The long-horizon memory experiment found two distinct failure shapes:

1. The last taught fact was absent in all three trials. It may not have been
   extracted, or a same-name save may have overwritten an existing memory.
2. Consolidation merged and deleted memories, after which an earlier fact was
   missing or wrong in two of three trials.

### Evaluation

- Rerun the long-horizon case with retained stores and inspect all failure
  classifications.
- Run `bench:recall`, `bench:inject`, memory lifecycle tests, and the relevant
  multi-session evals.
- Measure both fact retention and irrelevant-memory growth; solving loss by
  retaining everything without bound is not acceptable.

### Scale and historical coverage, only after fidelity

- Add the VectorStore id-to-index map before larger corpora make full sync
  quadratic; retain rebuildability from the Markdown source of truth.
- Backfill archived sessions through a bounded, resumable, leased job rather
  than an unbounded startup scan.
- Consider progressive disclosure only as a measured read-path redesign. A
  navigational summary plus on-demand bodies may beat a byte cap, but it changes
  MCP/tool surfaces and prompt-cache behavior.

### Acceptance gate

- The three taught regional facts survive extraction, consolidation, retrieval,
  and rendering in every required trial.
- Recall quality does not regress and injected bytes remain within the existing
  budget.

## 6. Workstream 3 — scoped permissions for writable subagents

### Current state

Read-only subagents use `explore` mode, which filters mutating tools and does not
prompt. Writable subagents can use a tool allowlist, but once a mutating tool is
allowed they inherit the parent's path and network reach. The dormant
`permissionProfile` path is not a safe shortcut: it duplicates the live rules
system and its hand-maintained tool map is incomplete, especially for MCP and
newer built-ins.

### Design direction

Use one permission decision pipeline:

1. Agent mode supplies the coarse read-only/build boundary.
2. The agent definition supplies an optional tool allowlist.
3. A subagent capability envelope narrows the parent's authority with path,
   network, shell, and subprocess constraints.
4. Existing permission rules evaluate the concrete target and requested
   operation inside that envelope.
5. Child agents may only reduce, never expand, their parent's authority.

Do not maintain a second map that separately guesses which capabilities each
tool needs. Tool registration metadata or the existing target extraction should
provide the authoritative operation and target.

### Phases

The specification is `docs/specs/2026-09-27-agent-control-and-definitions.md`
§5 — the envelope's semantics, precedence, MCP and inheritance rules, and the
questions its own §6 leaves open. What remains:

1. Apply it in tool-definition filtering and again at execution time to prevent
   stale-definition or dynamic-tool bypasses.
2. Cover built-ins, extension tools, MCP tools, background shells, and nested
   agents.
3. Expose clear denial events without adding denied calls to `toolSpans`.

### Acceptance gate

- A writable subagent restricted to directory A cannot write, shell into, or
  launch a subprocess targeting directory B.
- A network-disabled subagent cannot use web tools or network-capable MCP tools.
- A child cannot request broader authority than its parent.
- Read-only defaults and existing definition tool allowlists remain compatible.
- Unknown dynamic tools fail closed with an actionable denial reason.

## 7. Workstream 4 — instruction hierarchy

### Current state

The loader reads one non-empty `CLAUDE.md` or `AGENTS.md` from the global
directory and one from the project root. `CLAUDE.md` wins within a directory.
It does not walk a monorepo hierarchy, resolve imports, or apply glob-scoped
rules.

### Required specification decisions

Before implementation, settle:

- the directory walk boundaries and ordering;
- whether the session project or repository root anchors the walk;
- precedence between `CLAUDE.md`, `AGENTS.md`, imports, and scoped rule files;
- cycle, depth, size, and outside-project rules for imports;
- how symlinks and duplicate real paths are handled;
- when a glob-scoped rule becomes relevant;
- whether scoped rules are frozen for a session or placed in the ephemeral tail;
- how `/context` explains source, precedence, scope, and byte/token contribution.

### Recommended phases

1. **Walk-up hierarchy:** load deterministic ancestor instructions from the
   repository boundary to the active project, preserving the existing
   per-directory `CLAUDE.md` preference unless the spec changes it.
2. **Explicit imports:** add bounded, cycle-safe imports with paths resolved
   relative to the importing file and a clear policy for leaving the project.
3. **Glob-scoped rules:** define a `.freecode/rules/` format and inject matching
   guidance based on files actually in scope, without rewriting stable cache
   prefixes on every inner-loop turn.
4. **Observability:** extend `/context` so users can see which files and rules
   were loaded and why, without logging their contents.

### Verification

- Precedence matrix covering global, repository, nested project, imported, and
  scoped instructions.
- Cycle, missing-import, symlink, and outside-project tests.
- Windows and POSIX path/glob tests.
- Prompt-cache tests proving stable ordering and no needless prefix churn.
- An eval A/B across representative provider, memory, TUI, and checkpoint tasks
  before changing the default loading behavior.

### Acceptance gate

- Monorepo packages receive their applicable instructions in deterministic
  order.
- Imports cannot escape policy boundaries or recurse indefinitely.
- Scoped rules activate only for matching work and their inclusion is visible
  in `/context`.
- Existing root-only projects see no semantic change unless they opt into new
  files or features.

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
