# Recorded decisions — do NOT "fix"

Behaviour that looks like a bug or an oversight and is neither. Each entry was
a deliberate choice, usually load-bearing for prompt caching, safety, or cost.
Before changing anything listed here, read the reason and the spec it cites;
if the reason no longer holds, delete the entry in the same PR.

Grouped by subsystem. Open bugs are in `TODO.md`; unbuilt features in
`ROADMAP.md`.


## Memory, sessions, knowledge graph

- **`MEMORY.md` is never injected.** Injecting it makes the cached system prefix
  depend on the store, so every save busts the session's prompt cache. Locked by a
  test in `mem-prompt.test.ts` (guidance block must be byte-identical).
- **`memory` is blocked in plan/review/explore.** Fail-closed was chosen knowingly;
  the cost is that a preference stated while planning isn't captured.
- **`MAX_SAVES_PER_RUN = 3` and the extraction gates.** The cap stands in for a
  consolidation pass that doesn't exist. Raise it only after consolidation ships.
- **Two logs — `messages.jsonl` mutable, `events.jsonl` append-only.** Looks like
  duplication; it is the reason compaction can trim history without destroying the
  record of what happened.
- **Cascade skips `Contradicts`; tag/cluster nodes relay but never score.**
- **The retrieval judge is off by default** (2026-09-25). Head to head on the
  memory eval suite the fixed judge was quality- and cost-neutral (23/24 off vs
  22/24 on, cost +5.5%, within noise; ledger `2026-09-25-memory-2`), and it is a
  network call per new topic. It trims irrelevant memories, which should pay
  once a store is large enough to fill the 2 KB block, so turning it back on
  needs a paired run on a large-store suite, not a hunch.
- **Similar memories are not suppressed at injection time.** `pnpm bench:inject`
  showed five on-topic filler notes out-ranking a directly matching fact, which
  then lost its body to the byte budget (2026-09-25). The renderer spends the
  budget in retrieval order by design; how similar memories rank is retrieval's
  job (scored by `bench:recall`), and merging duplicates is consolidation's.
  Adding a suppression pass is a tuning change and needs the paired eval in spec
  `2026-09-25-memory-efficiency-and-graph-explorer.md` §6 first.
- **Compaction fires on a cost target (120K), not on window fit.** Fit-only left a
  1M-window session re-sending 270K every turn — 48.1M input tokens in one
  7-message session. Raising `FREECODE_COMPACT_TARGET_TOKENS` reverts that.
- **Tool-result pruning freezes anything already sent whole.** It looks wasteful;
  it is what keeps the prompt-cache prefix byte-stable. Do not replace it with a
  sliding window.
- **`MAX_OVERFLOW_COMPACTIONS = 3`, and the retry is not re-wrapped.** A second
  overflow in one turn means compaction isn't converging; looping burns quota.
- **Stream events are bare `{type,…}` objects, not JSON-RPC notifications.** The
  envelope-free shape is intentional; changing it breaks all four clients at once.
  (Standardising on notifications is still worth considering — listed under fixes.)
- **`-32002` is a distinct code, not a generic internal error.** Two frontends
  answering one prompt is a race, not a failure; the loser renders "already
  answered" as state.
- **Web auth gates `/api` and `/events` but not the static SPA.** Gating the page
  would block the page that delivers the token.
- **k-means determinism (`SEED = 42`, id-sorted points).** Non-deterministic
  clustering means the same store retrieving different memories on different days.
- **The retry after a hook blocks compaction is a fixed 5,000 tokens of growth**
  (`BLOCKED_RETRY_GROWTH_TOKENS`, `compaction/service.ts`), not a
  `CompactionConfig` field. No hook needs to tune it; make it configurable when
  one does, not before. (Moved from TODO.md on 2026-11-15.)

## CLI, settings, env, IPC, hooks

- **Hook exit codes fail closed, timeouts fail open.** A hook that answered is
  trusted; a hook that never answered is skipped. Both directions are intentional.
- **`permissions` merges rather than overrides across scopes.** Deny is checked
  first, so a project can neutralize a user-scope allow by adding a deny — it just
  cannot delete it. That is the safe direction for a file that travels with a repo.
- **Bash prefix rules refuse compound commands.** `Bash(npm:*)` never matches
  `npm test && rm -rf /`; the word-boundary and shell-separator checks are the
  security property, not an oversight.
- **MCP argument patterns never match.** `mcp__linear(x)` fails closed by design;
  server-level rules are the supported granularity in v1.
- **Hook payloads are env vars, not stdin JSON.** A three-line bash script is a
  complete hook implementation in any language, with nothing to parse.

## Agent loop

- **Dynamic context is a user message at position 0, not a system block.** The
  static system block stays a stable cacheable prefix only because the tree, git
  HEAD and clock live below it, with a fixed id and `timestamp: 0`.
- **The project snapshot and the clock are frozen per session.** A fresher tree
  costs the entire conversation prefix; an hour-rounded clock exists so position 0
  doesn't rewrite itself on the hour boundary.
- **A frozen tool result is never shrunk.** Saving ~250 tokens by replacing a
  result already in the cached prefix costs a partial invalidation worth far more.
- **Oscillation scores inverse edits, not repeated edits.** Editing one file many
  times is what real work on a large file looks like.
- **Loop-health braking is two-tier (warn at 1×, stop at 2×).** Long legitimate
  tasks routinely breach the first threshold.
- **Memory extraction is fired without `await`.** The user's result must not wait
  on it, and a memory failure must never surface as a task failure.
- **`compactAndRetry` does not re-wrap its retry.** A second overflow in one turn
  means compaction isn't converging; looping burns quota.
- **A quota-exhausted 429 is never retried.** Waiting cannot help, and each retry
  re-sends the whole conversation for a guaranteed rejection.
- **Provider errors are stringified before they reach logs or the bus.** The SDK
  error carries the entire request on `requestBodyValues`.

## Provider layer

- **`PROVIDER_MAX_RETRIES = 0`.** The SDK's own retries multiply with
  `RecoveryManager`'s (3 × 5 = up to 15 full-conversation round trips per turn)
  and it treats an unpayable quota 429 as retryable.
- **Cache markers are set for every provider flavour at once.** The SDK routes
  `providerOptions` by key and ignores the rest, so a model reached through a
  gateway caches as well as a direct one, for free.
- **`ttl` is omitted at 5m rather than sent explicitly.** 5m is the server-side
  default, so omitting it keeps request bytes identical to the pre-knob build —
  the default path cannot regress.
- **The read anchor is the message *before* the newest assistant message, not
  `.slice(-2)`.** `convertToCoreMessages` expands one turn into two messages, so
  the two-back rule lands on two messages that are both new (measured: reads
  pinned at ~7K while input grew to 81K).
- **The last tool carries a cache breakpoint.** Anthropic caches up to and
  including a marked block, so one marker caches the whole tools array; the
  name-sorted tool list is what keeps "last" stable.
- **Malformed tool arguments fail the turn instead of being cast.** The AI SDK
  emits the raw JSON string as `input`; storing it poisons the session
  permanently, because it is re-sent every turn and rejected before reaching the
  model.
- **Timeouts sit at the fetch layer, never around `ProviderChunk`s.**
  `normalizeAiSdkStream` drops `tool-input-delta`, so a large tool call looks
  like a dead stream from above it.
- **`mapUsage` returns `undefined` rather than `0` for unknown counts**, so "no
  usage data" stays distinguishable from a real zero.
- **`modelSupportsImages` fails closed on an unknown model.** An image part sent
  to a text-only model is a hard 400.

## Tool system

- **Coercion is narrow: only an unambiguous numeric literal or exactly
  `"true"`/`"false"`.** `Number()`/truthiness turns `""` into `0` and `"false"`
  into `true`, hiding a malformed call instead of letting the validator surface
  it.
- **Coercion lives at the orchestrator boundary, not in each `execute()`.** The
  declared schema `type` is already the single source of truth, and MCP schemas
  can't be patched per tool.
- **Truncation keeps a head *and* a tail.** Build errors, stack traces and
  summaries live at the end; head-only threw away exactly what was needed.
- **Both truncation cuts snap to line boundaries.** A raw character index lands
  mid-token and the model reads a half-identifier as whole.
- **An `OutputStore` miss returns a message, never an error.** Degrading to
  "re-run the tool" is always recoverable.
- **`edit`/`write` record read-state but are excluded from dedup.** They record
  content the model has never been shown; deduping against it would claim "you
  already have this" while the transcript holds the pre-edit text.
- **Read dedup has a kill switch (`FREECODE_READ_DEDUP=0`).** It is the only
  token-efficiency measure that changes what the model *sees*.
- **An unannotated MCP tool is treated as mutating.** An absent `readOnlyHint`
  says nothing about the tool; guessing "harmless" is how `create_issue` gets
  re-run.
- **Tool defs are sorted by name.** `buildToolsParam` marks the last tool with a
  cache breakpoint, so a stable order is what keeps the tools block cacheable.
- **A `bash` timeout resolves as a failure, not a slow success**, with partial
  output attached — otherwise the loop concludes the command worked.
- **Tools return data, never markup.** Four frontends render the same
  `StreamEvent`s their own way.

## Context engine

- **The project snapshot is one level deep.** The model has `ls`/`glob`/`grep`; a
  recursive monorepo listing would cost thousands of tokens *every turn* to say
  what one tool call can answer.
- **The snapshot and clock are frozen per session.** A fresher tree rewrites
  position 0 and invalidates the entire conversation prefix.
- **Dynamic context is `messages[0]`, not a system block.** The static system
  block stays cacheable only because everything that moves lives below it.
- **`memoryContext` is never rendered into position 0.** It rendered
  `recentMessages`, which grow every turn and are already in the history verbatim.
- **Skills are advertised as name + description only, sorted.** Full bodies load
  on demand via the `skill` tool; the sort keeps identical skill sets producing
  identical bytes.
- **Nothing from `repo-map/` is injected into the prompt.** The pull model means
  symbols cost tokens only when the model asks for them.
- **`getFileSymbols` parses fresh rather than reading the project cache.**
  Single-file results must never be stale.
- **The tree-watcher runs `persistent: false`.** A watcher that keeps the process
  alive hangs every short-lived CLI invocation that ran one turn.
- **The system-prompt loader tries disk before the embedded copy.** Dev picks up
  `system.md` edits without a rebuild; the compiled binary has no disk copy to
  find.

## Eval harness

- **Unit tests stay `*.test.ts` under `src/`.** The 98 existing tests are unit
  tests and must not migrate into `evals/`. A file under `evals/` runs a real
  agent turn; anything that doesn't belongs next to the code it tests. Conflating
  the two is exactly what dilutes the eval signal in the prior art.
- **OTLP export stays off the hot path.** Live streaming is deferred in
  `2026-08-10-agent-observability.md` §7 for a stated reason; shipping from the
  durable log costs only immediacy.

### Efficiency scorer (2026-09-04)

Found while writing `specs/2026-09-04-harness-cost-efficiency.md`.

- **Eval efficiency stays warn-only** (`scorers/efficiency.ts`). Cost moves when
  the suite changes as readily as when the agent changes; A/B (`eval ab`) is the
  instrument for harness experiments, never the gate.

## Memory consolidation

- **No bare `delete` verb for the consolidator.** A memory can only be removed
  as the `supersedes:` list of a merge. mem0 is evidence for this, not against:
  its v2 manager offers ADD/UPDATE/DELETE/NONE (`configs/prompts.py:176`) and
  its v3 extraction prompt is ADD-only with `linked_memory_ids`.
- **No SQLite job queue for consolidation.** codex needs leases and ownership
  tokens because Phase 1 runs ×8 in parallel across many rollouts. We
  consolidate one project, serially, at most daily. Take the outcome taxonomy
  (`succeeded` / `succeeded_no_output` / `failed`) and the retry backoff; leave
  the queue.
- **Semantic memories do not decay with age.** jcode decays confidence for
  everything; we decay episodes only. Demoting "user prefers tables" for being
  old is how a system forgets a standing instruction. Use is recorded for all
  types, but only episodes' scores are multiplied.

### What the benchmarks contradicted in the spec (shipped 2026-08-23)

Spec `specs/2026-08-23-memory-consolidation.md`, plan
`plans/2026-08-23-memory-consolidation.md`, results
`apps/core/src/memory/bench/README.md`. Six phases, 725 tests passing.

Three findings worth keeping, because each contradicts something the spec said:

- **The free abstention gate does not exist.** Top cosine for on-topic queries
  (0.674–0.932) overlaps irrelevant ones (0.588–0.719); a within-query z-score
  overlaps too. Bi-encoder similarity between short texts has a high,
  corpus-dependent floor. Abstention needs a reader (D15). `bench/probe.ts`
  reproduces the table — run it before proposing any new local floor.
- **BM25 + RRF trades ordering for coverage.** recall@5 and precision@5 up, MRR
  and nDCG down. Right for a block the model reads whole; wrong if retrieval is
  ever used somewhere that only reads the first result.
- **A log-scaled use boost cannot overcome exponential decay.** `1 + 0.1·ln(u+1)`
  tops out near 1.5× against a 4× decay span. Use raises the decay floor instead.

## Gemini web-session provider

- **`supportsTools: false`.** Measured, not unfinished: the session emitted a
  tool call ~56% of the time and fabricated on the rest. Shrinking the prompt
  55× and cutting 16 tools to 1 did not move it; removing the *need* for a tool
  call did. See spec §4 E1/E2 before touching this.
- **`allowsAuxiliaryCalls` fails open** (`!== false`, not `=== true`). A wrong
  `false` would switch memory off for every provider — far worse than one extra
  request against a quota.
- **The pinned build label rots by design.** It is a fallback; the live scrape
  is the source of truth, and a 4xx force-refreshes it.
- **Every request is a fresh chat** (empty ids in payload slot 2). Using the
  server-side thread would put conversation state somewhere `session/` cannot
  inspect, resume, fork or export.

## OpenHands comparison (2026-09-01)

- **`session.compact`'s synchronous result is better than theirs.**
  `protocol.ts:244` returns `{compacted, tokensBefore, tokensAfter, reason}`
  directly. OpenHands' `/condense` acks only that work started, forcing a
  150-line frontend hook (`use-await-context-compaction.ts`) with a 2.5s settle
  window and 90s timeout to reconstruct the same numbers. Keep ours.
- **Do not adopt ACP or the multi-backend registry.** Canvas's product is being
  a universal frontend for other people's agents; FreeCode's frontends and
  backend ship together.

## Anthropic subscription login (2026-09-05)

- **No multi-account support.** One Anthropic login per machine
  (`auth.json` is keyed by provider, not by account). Deliberate YAGNI in the
  spec's §2 non-goals; listed here so the docs claim has a home.
- **`anthropic` is the only provider with an OAuth mode.** `freecode auth
  login` rejects any other provider by name. Fine today — no other catalogue
  entry has a subscription surface freecode can reach.
