# Priority Implementation Plan

> **Status:** Proposed
> **Date:** 2026-10-15
> **Scope:** Runtime and eval integrity, memory fidelity, subagent permission
> scoping, performance and cost measurement, instruction hierarchy, and backlog
> reconciliation.
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

| Order | Workstream                                             | Why it is here                                                                                                         |
| ----- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 1     | Reconcile stale TODO and roadmap entries               | The backlog currently advertises already-built work, making prioritization unreliable.                                 |
| 2     | Close runtime and eval integrity gaps                  | Headless memory, eval isolation, judge identity, output bounds, and compaction traces affect correctness and trust.    |
| 3     | Build measurement foundations                          | Performance and cost changes cannot be evaluated credibly without complete accounting and repeatable fixtures.         |
| 4     | Diagnose and prevent memory fact loss                  | Existing long-horizon evidence shows missing and lost facts; new memory features should not be layered on top of that. |
| 5     | Scope writable subagents                               | Read-only subagents are confined, but writable subagents lack path and network boundaries.                             |
| 6     | Add an instruction hierarchy                           | This is the roadmap's highest-value remaining extensibility item and benefits from the measurement foundation.         |

The runtime/eval fixes in Workstream 2 should be separate PRs because they have
different failure modes. Workstream 3 should begin before any optimization
experiment. Workstreams 4–6 each require their own design or spec amendment and
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

## 4. Workstream 1 — backlog reconciliation

### Problem

`TODO.md` says it must shrink and that entries must be verified against code,
but several entries describe work already present. At minimum, the following
need reconciliation:

- Eval shutdown now closes MCP clients and disposes language servers.
- `METHODS` now includes the previously missing memory, configuration, model,
  and session methods; `session.send` has the richer parameter and result type.
- JSON-RPC parameter validation now returns `-32602` through the shared required
  parameter table.
- Compaction now preserves a bounded founding user instruction.
- Multimodal message parts and image-bearing session sends are implemented, but
  the roadmap still calls multimodal input unbuilt.

### Implementation

1. Verify each candidate against source and tests.
2. Delete resolved TODO entries and their twin **Known gaps** entries in the
   documentation site in the same change.
3. Move deliberate limitations to `docs/DECISIONS.md` rather than leaving them
   as bugs.
4. Keep incomplete follow-on work separate. For example, image support being
   built does not automatically resolve the cost of reading an image for a
   text-only model.
5. Add a lightweight CI check only if a stable machine-checkable rule exists;
   do not infer implementation status from unchecked Markdown alone.

### Acceptance gate

- Every retained checkbox names behavior that is still absent or defective in
  the current tree.
- `ROADMAP.md` contains only unbuilt features or redesigns.
- Resolved items are removed rather than marked permanently complete.

## 5. Workstream 2 — runtime and eval integrity

These items are independently shippable. They are grouped because each makes a
successful-looking run less trustworthy than it appears.

### 5.1 Complete background memory work in headless runs

`freecode run` calls `process.exit()` immediately after the loop returns. The
memory system tracks fire-and-forget work and exposes `drainMemoryJobs`, while
session exit already gives final extraction a bounded wait, but the headless
command does not run that lifecycle before exiting.

Implementation requirements:

- Route both success and error exits through the shared session-end path.
- Give final extraction, citation persistence, and consolidation a single
  bounded drain budget; do not wait forever on a provider outage.
- Report pending or timed-out work explicitly rather than silently treating it
  as complete.
- Stop MCP servers, hooks, shells, agents, and other process-owned resources
  before choosing the exit code.
- Preserve pipe semantics: assistant stdout must not gain lifecycle chatter.

Acceptance requires a short headless session to persist an eligible final
memory before exit, a timed-out auxiliary call to exit within the configured
budget, and no leaked child process.

### 5.2 Make eval memory deterministic for every case

Cases with explicit memory fixtures already receive an isolated store. Ordinary
unsandboxed cases still run with `projectPath: process.cwd()` and may receive
automatic recall from the developer's live project memory. That makes a gate's
result depend on the machine and date.

Implementation requirements:

- Give every trial an explicit memory policy: empty isolated store, committed
  fixture store, or a declared multi-session learning store.
- Default ordinary trajectory and judged cases to an empty isolated store.
- Keep extraction and consolidation frozen unless the case explicitly tests
  them.
- Record the memory-fixture identity and policy in the report, never the memory
  bodies.
- Ensure cleanup covers both the Markdown store and derived graph sidecars.

Acceptance requires the same case and commit to receive the same initial memory
corpus on clean and memory-heavy developer machines.

### 5.3 Key judged baselines by judge identity

`SuiteReport` records the judge, but `baselineFor` currently filters by suite,
subject model, and auth mode only. A run graded by one judge can therefore be
compared with history graded by another.

Implementation requirements:

- Include normalized judge provider and model in baseline compatibility.
- Treat a judge switch like a subject-model or auth-mode switch: start a fresh
  baseline rather than reporting a regression.
- Keep older history without a recorded judge readable, but do not silently
  treat it as comparable to a known different judge.
- Add report tests for judge switch, missing historical judge, auth switch, and
  same-judge continuity.
- Calibrate any release-blocking judge against human labels before trusting its
  numeric floor.

### 5.4 Bound frontend tool-completion payloads

The orchestrator caps `displayOutput` and preserves full output in the pageable
output store, but the loop's `tool_complete` event still sends raw
`result.stdout` or `result.error`. A large command can therefore cross IPC in a
single message even though model and display paths already have bounded views.

Implementation requirements:

- Send the bounded display view, truncation metadata, and output-store handle in
  the completion event.
- Preserve the full value only in the per-session output store.
- Make “show more” use the existing `output` tool or a presentation-safe fetch;
  do not add a second full-output store.
- Define a bounded error path too—errors can be as large as stdout.
- Test large built-in, MCP, and hook-modified outputs.

### 5.5 Make compaction traces describe the real transition

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

### 5.6 Remove the fixed TUI completion delay

The TUI still waits 500 ms after the backend returns so the final token state is
briefly visible, then removes the progress row. Preserve the statistics in a
settled row and end the working state immediately. This is a known presentation
delay, not a provider-speed optimization, and can ship without a paid model
eval if deterministic TUI tests cover the state transition.

### Acceptance gate

- Headless exits do not discard bounded background memory work.
- Eval cases cannot read undeclared developer memory.
- Judged baselines never cross a known judge switch.
- No single tool-completion event carries unbounded output.
- Compaction traces expose comparable token measures and the body-free message
  transition.
- The TUI exits its working state without the fixed half-second pause.

## 6. Workstream 3 — measurement foundations

This workstream blocks claims that an optimization is faster or cheaper. It
does not block independent correctness fixes.

### 6.1 Local performance harness

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

### 6.2 Complete cost accounting

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

### 6.3 Experiment ledger

Add an append-only record for each performance or cost experiment with:

- hypothesis and variants;
- commit and workload;
- quality, latency, token, and dollar results;
- known accounting gaps;
- verdict: kept, rejected, or inconclusive.

Reuse the existing eval experiment format where it fits instead of inventing a
second incompatible result model.

### 6.4 Re-establish the long-task baseline

Rebuild the benchmark image containing `rg`, rerun the nine long-task trials,
and rejudge them with the documented judge configuration. Treat the earlier v2
numbers as historical evidence, not a valid comparison baseline, because all 88
of their `grep` calls failed.

### 6.5 Measurement-gated optimization queue

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

## 7. Workstream 4 — memory fidelity before memory expansion

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

## 8. Workstream 5 — scoped permissions for writable subagents

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

## 9. Workstream 6 — instruction hierarchy

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

## 10. Delivery slices

Keep review and rollback simple:

1. **PR A:** Remove verified stale TODO/roadmap and documentation-site gaps.
2. **PR B:** Headless session-end lifecycle and bounded memory drain.
3. **PR C:** Eval memory isolation and judge-compatible baselines.
4. **PR D:** Bounded tool-completion events and compaction trace fidelity.
5. **PR E:** Remove the fixed TUI completion delay.
6. **PR F:** Local performance harness and baseline report format.
7. **PR G:** Complete cost ledger and task-tree aggregation.
8. **PR H:** Rebuilt long-task baseline and recorded results; no behavioral
   change.
9. **PR I:** Memory failure instrumentation and deterministic reproductions.
10. **PR J:** Memory extraction/consolidation safeguards, gated by memory
    benchmarks.
11. **PR K:** Subagent capability-envelope spec and implementation.
12. **PR L:** Instruction hierarchy in separately gated phases.

Do not combine the memory, permissions, and instruction changes. Each changes
what the model sees or what tools can do and therefore needs isolated evidence.

## 11. Definition of done

This plan is complete when:

- the backlog no longer lists the confirmed built items above;
- headless memory work, eval memory, judge baselines, tool payloads, and
  compaction traces satisfy Workstream 2's integrity gates;
- local performance and complete task-cost baselines are reproducible;
- the repaired long-task benchmark has replaced the broken-tool baseline;
- memory merges cannot silently discard taught facts;
- writable subagents can be constrained by path and network without gaining
  authority through dynamic tools;
- monorepo, imported, and scoped instructions have deterministic, observable
  behavior; and
- every behavioral default change has the tests and eval evidence required by
  its governing spec.

## 12. References

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
