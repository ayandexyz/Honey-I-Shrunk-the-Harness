# Priority Implementation Plan

> **Status:** Proposed
> **Date:** 2026-10-15
> **Scope:** Runtime and eval integrity, memory fidelity, subagent permission
> scoping, performance and cost measurement, and instruction hierarchy.
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
| 1     | Close runtime and eval integrity gaps | Judge identity, output bounds, and compaction traces affect correctness and trust.                                     |
| 2     | Build measurement foundations         | Performance and cost changes cannot be evaluated credibly without complete accounting and repeatable fixtures.         |
| 3     | Diagnose and prevent memory fact loss | Existing long-horizon evidence shows missing and lost facts; new memory features should not be layered on top of that. |
| 4     | Scope writable subagents              | Read-only subagents are confined, but writable subagents lack path and network boundaries.                             |
| 5     | Add an instruction hierarchy          | This is the roadmap's highest-value remaining extensibility item and benefits from the measurement foundation.         |

The runtime/eval fixes in Workstream 1 should be separate PRs because they have
different failure modes. Workstream 2 should begin before any optimization
experiment. Workstreams 3–5 each require their own design or spec amendment and
should not be combined into one implementation PR.

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

## 4. Workstream 1 — runtime and eval integrity

These items are independently shippable. They are grouped because each makes a
successful-looking run less trustworthy than it appears.

### 4.1 Make compaction traces describe the real transition

`compact.occurred` still carries only estimated `beforeTokens` and
`afterTokens`. The apply path already knows message counts and compacted message
IDs, but the event cannot show how many messages left the active view or explain
long-session drift. Existing measurements found the token magnitude could be
wrong by an order of magnitude.

Implementation requirements:

- Record estimated transcript tokens and measured provider-request tokens as
  different fields; never compare unlike quantities under one name.
- Record counts and body-free entry IDs for compacted and preserved messages so
  a trace can identify the boundary without exposing content.
- Carry `messagesBefore` and `messagesAfter` from the apply result.
- Update the trace fold, JSON output, OTLP attributes, and eval scorers together.
- Preserve backwards compatibility for older rollout logs.

### 4.2 Remove the fixed TUI completion delay

The TUI still waits 500 ms after the backend returns so the final token state is
briefly visible, then removes the progress row. Preserve the statistics in a
settled row and end the working state immediately. This is a known presentation
delay, not a provider-speed optimization, and can ship without a paid model
eval if deterministic TUI tests cover the state transition.

### Acceptance gate

- Compaction traces expose comparable token measures and the body-free message
  transition.
- The TUI exits its working state without the fixed half-second pause.

## 5. Workstream 2 — measurement foundations

This workstream blocks claims that an optimization is faster or cheaper. It
does not block independent correctness fixes.

### 5.1 Local performance harness

Build deterministic, network-free fixtures for:

- cold startup and first interactive input;
- prompt submission to first visible text;
- session resume for small and large transcripts;
- fixed-size streaming with controlled chunk schedules;
- checkpoint capture in small and large Git repositories;
- repeated history loads with and without mutations.

Report p50, p75, and p95 plus work counts such as bytes parsed, entries
converted, Markdown parses, renders, and files statted. Separate backend time,
frontend rendering, and provider time so one cannot be mistaken for another.

### 5.2 Complete cost accounting

Define one ledger entry per provider attempt, linked to:

- root task and session;
- child session, when applicable;
- operation purpose;
- resolved provider, model, and auth mode;
- token and cache usage;
- pricing-table vintage;
- completion state, including unknown or partial usage.

Extend task-level cost folding to include subagents, verifier calls, compaction
summarization, memory auxiliary calls, redirection, and cache warming. Count each
attempt exactly once. Keep benchmark-grader cost separate from runtime cost.

Acceptance requires a synthetic task containing a main turn, child agent,
compaction, memory operation, and cache refresh to reconcile with a known call
ledger.

### 5.3 Experiment ledger

Add an append-only record for each performance or cost experiment with:

- hypothesis and variants;
- commit and workload;
- quality, latency, token, and dollar results;
- known accounting gaps;
- verdict: kept, rejected, or inconclusive.

Reuse the existing eval experiment format where it fits instead of inventing a
second incompatible result model.

### 5.4 Re-establish the long-task baseline

Rebuild the benchmark image containing `rg`, rerun the nine long-task trials,
and rejudge them with the documented judge configuration. Treat the earlier v2
numbers as historical evidence, not a valid comparison baseline, because all 88
of their `grep` calls failed.

### 5.5 Measurement-gated optimization queue

Do not implement every candidate at once. Use the harness to admit one change at
a time:

1. **TUI active-message rendering:** `StreamingAssistantMessage` rebuilds the
   Markdown component from the entire accumulated reply whenever dirty. Reuse
   only semantically stable regions and prove final rendered-line equality for
   fences, tables, references, Unicode, resizing, and interruption.
2. **Session history cache:** `readEntries` reparses the complete JSONL file on
   each send. Implement a bounded store-owned cache only if preparation timing
   is material; invalidate it on append, compaction, navigation, rewind,
   import, deletion, and detected external changes.
3. **Checkpoint scanning:** untracked-file size checks call `stat` sequentially.
   Split capture timing first, then try bounded parallel reads only if this phase
   dominates. The pre-tool checkpoint barrier and shadow-index isolation must
   remain intact.
4. **Project-instruction size:** this repository's selected root `CLAUDE.md` is
   now over 82 KB, roughly ten times the shipped base system prompt. Prototype a
   compact root guide plus topic documents only after real request attribution
   exists, and use eval A/B to prove required subsystem rules are still found.
5. **Operation-specific model and effort:** extraction, compaction, and
   verification may use different policies only after their full cost and
   fallback behavior are visible. Respect an explicit user selection unless a
   configured routing policy says otherwise.
6. **Selective tool results and repeat-work reduction:** target observed output
   families and repeated reads, not global compression. The previous blanket
   Bash-compression experiment increased total cost and must not be retried as
   an unmeasured default.

Each accepted optimization needs a recorded user-facing metric, local work
metric, correctness result, memory tradeoff, and full task-cost result.

### Acceptance gate

- A developer can reproduce a local before/after performance report without a
  paid model call.
- A paid A/B report clearly separates runtime, child-agent, auxiliary, and
  grader cost.
- The long-task baseline uses a functioning tool image and records its exact
  commit, model, and judge.

## 6. Workstream 3 — memory fidelity before memory expansion

### Current evidence

The long-horizon memory experiment found two distinct failure shapes:

1. The last taught fact was absent in all three trials. It may not have been
   extracted, or a same-name save may have overwritten an existing memory.
2. Consolidation merged and deleted memories, after which an earlier fact was
   missing or wrong in two of three trials.

The first task is diagnosis, not prompt tuning.

### Phase 0 — preserve and classify the failures

- Keep the relevant eval sandboxes and memory stores for inspection.
- Record extraction candidates, accepted writes, same-name replacements,
  consolidation inputs, proposed replacement, and final live entries using
  controlled fixtures. Do not put memory bodies into rollout or OTLP logs.
- Classify each missing fact as extraction omission, save collision,
  consolidation omission, retrieval miss, judge rejection, or rendering-budget
  drop.

### Phase 1 — safe extraction updates

- Add a deterministic fixture where multiple turns teach additive facts under
  the same topic.
- Define whether a same-name save replaces, merges, or versions an entry.
- Prevent silent loss when the new extraction contains only a subset of the
  existing durable facts.

### Phase 2 — loss-resistant consolidation

- Give each merge explicit source-memory provenance.
- Validate that the proposed replacement covers the durable claims represented
  by its sources before deleting any source entry.
- If coverage cannot be established, retain the sources and report the merge as
  skipped or degraded.
- Preserve the existing rule that there is no unconstrained delete verb.

### Phase 3 — evaluation

- Rerun the long-horizon case with retained stores and inspect all failure
  classifications.
- Run `bench:recall`, `bench:inject`, memory lifecycle tests, and the relevant
  multi-session evals.
- Measure both fact retention and irrelevant-memory growth; solving loss by
  retaining everything without bound is not acceptable.

### Phase 4 — scale and historical coverage, only after fidelity

- Add the VectorStore id-to-index map before larger corpora make full sync
  quadratic; retain rebuildability from the Markdown source of truth.
- Backfill archived sessions through a bounded, resumable, leased job rather
  than an unbounded startup scan.
- Add LongMemEval-S as an external-quality reference; the in-repository corpus
  remains useful for regressions but cannot establish absolute retrieval
  quality by itself.
- Consider progressive disclosure only as a measured read-path redesign. A
  navigational summary plus on-demand bodies may beat a byte cap, but it changes
  MCP/tool surfaces and prompt-cache behavior.

### Acceptance gate

- The three taught regional facts survive extraction, consolidation, retrieval,
  and rendering in every required trial.
- A failed or uncertain merge deletes no source memory.
- Recall quality does not regress and injected bytes remain within the existing
  budget.

## 7. Workstream 4 — scoped permissions for writable subagents

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

1. Write or amend the agent-control specification with envelope semantics,
   precedence, MCP behavior, and inheritance.
2. Add the envelope to user-defined agent types and validation without changing
   defaults.
3. Apply it in tool-definition filtering and again at execution time to prevent
   stale-definition or dynamic-tool bypasses.
4. Cover built-ins, extension tools, MCP tools, background shells, and nested
   agents.
5. Expose clear denial events without adding denied calls to `toolSpans`.

### Acceptance gate

- A writable subagent restricted to directory A cannot write, shell into, or
  launch a subprocess targeting directory B.
- A network-disabled subagent cannot use web tools or network-capable MCP tools.
- A child cannot request broader authority than its parent.
- Read-only defaults and existing definition tool allowlists remain compatible.
- Unknown dynamic tools fail closed with an actionable denial reason.

## 8. Workstream 5 — instruction hierarchy

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

## 9. Delivery slices

Keep review and rollback simple:

1. **PR A:** Compaction trace fidelity.
2. **PR B:** Remove the fixed TUI completion delay.
3. **PR C:** Local performance harness and baseline report format.
4. **PR D:** Complete cost ledger and task-tree aggregation.
5. **PR E:** Rebuilt long-task baseline and recorded results; no behavioral
   change.
6. **PR F:** Memory failure instrumentation and deterministic reproductions.
7. **PR G:** Memory extraction/consolidation safeguards, gated by memory
   benchmarks.
8. **PR H:** Subagent capability-envelope spec and implementation.
9. **PR I:** Instruction hierarchy in separately gated phases.

Do not combine the memory, permissions, and instruction changes. Each changes
what the model sees or what tools can do and therefore needs isolated evidence.

## 10. Definition of done

This plan is complete when:

- compaction traces satisfy Workstream 1's integrity gates;
- local performance and complete task-cost baselines are reproducible;
- the repaired long-task benchmark has replaced the broken-tool baseline;
- memory merges cannot silently discard taught facts;
- writable subagents can be constrained by path and network without gaining
  authority through dynamic tools;
- monorepo, imported, and scoped instructions have deterministic, observable
  behavior; and
- every behavioral default change has the tests and eval evidence required by
  its governing spec.

## 11. References

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
