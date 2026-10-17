# Making FreeCode cheaper: token and cost efficiency

Date: 2026-10-12  
Reviewed base commit: `97793b1e`, with existing working-tree changes  
Status: partially implemented; task cost ledger built 2026-10-17, no paid evaluations performed.

Companion: [UI and latency recommendations](2026-10-11-performance-recommendations.md). Keep these documents separate: a faster renderer usually does not reduce the provider bill, and a cheaper model can take longer to complete a task.

## What can change?

**Any part of FreeCode that affects token use or task completion is a candidate:** the system prompt, project instructions, tool descriptions and schemas, tool output, memory, context selection, compaction, model and effort selection, delegation, retries, and loop policy. This review is not restricted to prompt wording.

The constraint is the outcome: preserve required capabilities, instruction precedence, permissions, and task quality. Business logic stays in `apps/core`; frontends expose controls and measurements through IPC. A cost optimization should not silently turn a request into a smaller task.

Cost accounting is now complete for recorded runtime attempts. The next choices are to measure the assembled request, then test smaller recurring instructions plus fewer unnecessary model turns. Model routing and compaction changes come after that baseline.

## 1. Optimize cost per successful task

Track these separately:

| Metric                                           | What it tells us                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| Total input tokens                               | Context volume processed across all requests                                   |
| Uncached input, cache reads, cache writes        | Which parts of that volume are charged differently                             |
| Output and reasoning tokens                      | Generation work; short visible answers can still involve substantial reasoning |
| Requests, retries, tool calls, child-agent calls | How much work was required to finish                                           |
| Total runtime cost                               | Main agent plus supporting calls and failed attempts                           |
| Cost per successful task                         | Whether lower spending still delivers useful results                           |
| Success rate, serious failures, latency          | Whether the cost reduction is acceptable                                       |

For a fixed benchmark workload:

```text
cost per successful task = cost of ALL attempts / number of successful tasks
```

Include failed attempts in the numerator. With no successes, report no successful outcome rather than a misleading zero. Also report results by task category so an aggregate cannot hide a regression on difficult work.

Illustrative example, not a measurement: spending $1.00 on ten attempts with nine successes costs about $0.111 per success. Spending $0.70 with five successes costs $0.140 per success. The second configuration spends less in total but delivers worse value.

For subscription/OAuth runs, report tokens, task success, latency, and observed quota behavior separately. [pricing.ts](../apps/core/src/providers/pricing.ts) correctly leaves OAuth per-call dollars undefined. A subscription is not free inference, and API list prices are not its actual marginal bill.

### Token accounting matters

FreeCode's normalized input count includes cache reads and writes. The current pricing fold effectively computes:

```text
uncached = max(0, input - cache_read - cache_write)
cost = (uncached × input_rate
      + cache_read × read_rate
      + cache_write × write_rate
      + output × output_rate) / 1,000,000
```

Do not add cached tokens to input a second time. Do not add reasoning tokens to output again when the provider's normalized output already includes them. For example, Google's [pricing documentation](https://ai.google.dev/gemini-api/docs/pricing) explicitly includes thinking tokens in output pricing. Validate each provider's usage mapping.

Prices depend on the actual model, endpoint, cache policy, and applicable pricing tier. This document intentionally does not select a universal cheapest model or promise a savings percentage.

## 2. What FreeCode has already done

Start from the implementation, not the older problem descriptions in the specs.

| Optimization                           | Current evidence                                                                                                                      | Implication                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| System/tool guidance compression       | [September cost-efficiency spec](specs/2026-09-04-harness-cost-efficiency.md) records earlier compression and behavioral checks       | Further shortening is a new experiment, not the first audit       |
| Read output without per-line numbering | [read.ts](../apps/core/src/tools/read.ts) defaults numbering off                                                                      | Preserve the existing saving; do not claim it as new              |
| Repeated file-read suppression         | `read.ts` detects unchanged content using read state                                                                                  | Investigate remaining redundant reads before adding another cache |
| Recoverable tool-output limits         | [orchestrator.ts](../apps/core/src/tools/orchestrator.ts) stores output before limiting the model/display views                       | Keep recovery available when reducing initial output              |
| Stable prompt prefixes                 | Session-frozen context, stable pruning decisions, and an ephemeral tail are implemented                                               | Avoid changes that rewrite old prompt positions on every turn     |
| Tool filtering                         | [defs-cache.ts](../apps/core/src/tools/defs-cache.ts) sorts definitions and filters read-only modes; the loop applies role allowlists | Tool selection already exists in limited forms                    |
| Skills loaded on demand                | [skills/prompt.ts](../apps/core/src/skills/prompt.ts) advertises names/descriptions, not full bodies                                  | Optimize the catalogue only if its measured size warrants it      |
| Cost-oriented compaction               | [tokens.ts](../apps/core/src/compaction/tokens.ts) has a 120,000-token target before the configured buffer                            | Compaction already considers more than window fit                 |
| Background memory policies             | Extraction cadence, consolidation gates, and a default-off retrieval judge exist                                                      | Preserve useful recall; avoid assuming every memory call is waste |
| Cache warming                          | [cache-warmer.ts](../apps/core/src/providers/cache-warmer.ts) has an economic decision and defaults off                               | Enabling it is a paid experiment, not an automatic saving         |

Two historical results deserve attention. The September spec reports lower cost after disabling read-line prefixes, but shell-output compression increased cost by 10.9% on its coding experiment through extra work. Those are recorded results from that model and workload, not fresh measurements or guarantees for today's setup.

The [memory efficiency spec](specs/2026-09-25-memory-efficiency-and-graph-explorer.md) similarly records cases where memory increased total spending while improving success enough to reduce cost per passed task. This is why switching everything off is not a reliable optimization strategy.

## 3. Recommended priorities

| Priority | Experiment                                           | Why it comes here                                                   | Main risk                                          |
| -------- | ---------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| P1       | Modularize oversized project guidance                | Large recurring input is visible in this checkout                   | Important instructions stop being loaded           |
| P1       | Refine system/tool guidance to reduce needless turns | One avoided request saves another context submission and generation | Weaker planning, verification, or scope discipline |
| P1       | Make reads/searches/tool results more selective      | Reduce new context before it enters repeated history                | Extra recovery reads erase savings                 |
| P2       | Select models and effort by operation                | Supporting tasks may not need the main coding model                 | Weak summaries, extraction, or verification        |
| P2       | Tune compaction against total continuation cost      | Lower context size can help long tasks                              | Lost details, cache rebuilds, rereads              |
| P2       | Reduce unnecessary delegation, retries, and nudges   | Avoid complete extra model conversations                            | Premature stopping or missed defects               |
| P3       | Evaluate tool discovery and cache-warming policies   | Potential value for large catalogues and long idle sessions         | Discovery overhead and speculative spend           |

These are priorities for experiments. None has a measured saving assigned yet.

## 4. Complete cost accounting before tuning behavior — built 2026-10-17

The body-free [task cost ledger](../apps/core/src/rollout/cost-ledger.ts) emits one row per provider attempt across a root session and every recorded child session. It records purpose, resolved model, auth mode, usage completeness, completion state, pricing vintage, and estimated USD without reading live configuration at fold time. Benchmark-grader attempts and totals remain structurally separate from runtime spending.

The implementation closes the previously identified coverage gaps:

- foreground, subagent, and verifier calls are joined through recorded parent/child session relationships;
- memory, compaction, redirection, prompt-hook, and final-flush calls share the auxiliary-call event;
- successful and failed cache warming emits a cost-bearing event;
- failed, timed-out, incomplete, and old-log attempts stay visible as partial or unknown rather than zero;
- `freecode trace <session> --cost-ledger [--json]` exposes the reconciliation.

Anthropic documents different cache write prices for different lifetimes and model-dependent read prices. Use the actual policy and rate rather than a universal multiplier. See [official prompt-caching documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

The regression fixture contains a main turn, verifier child, extraction, compaction, and cache refresh and reconciles all five attempts to an exact expected total. The remaining pricing limitation is policy metadata: comparisons involving cache TTL or a provider pricing tier still need those assumptions recorded when such policies are introduced.

### Measure the assembled request

Use the existing `/context` view and [context/breakdown.ts](../apps/core/src/context/breakdown.ts) as a starting point. [PromptCompiler.buildStaticSegments](../apps/core/src/context/compiler.ts) already distinguishes system prompt, project instructions, skills, agent types, and memory guidance.

Add or verify attribution for native tool schemas, history text, tool arguments/results, dynamic context, and the ephemeral tail. Measure the request after provider conversion as well as before it: local prose length is not the whole payload.

Per-section counts are estimates unless measured with an appropriate tokenizer; provider usage is the authoritative total. Record safe category totals, not raw prompts or project paths in rollout/OTLP. Existing logs deliberately omit message bodies, so a prompt audit must measure at construction time or use explicitly controlled fixtures.

## 5. Reduce oversized project instructions first

There is a concrete local opportunity. At inspection time:

| File                                                    | Size on disk |
| ------------------------------------------------------- | ------------ |
| Root `CLAUDE.md`                                        | 75,962 bytes |
| Root `AGENTS.md`                                        | 47,215 bytes |
| Shipped `session/prompt/system.md` in this working tree | 8,094 bytes  |

These are bytes, not exact token counts. [instructions.ts](../apps/core/src/context/instructions.ts) chooses the first nonempty `CLAUDE.md` or `AGENTS.md` at each of the global and project locations. It sends the selected file in full. It does **not** concatenate both root files. For this repository, root `CLAUDE.md` wins.

The project file is therefore a larger source-size target than the base system prompt. Global instructions and overrides can change the actual request; inspect `/context` rather than extrapolating these sizes to every user.

Proposed approach:

1. Keep a compact root guide containing architecture boundaries, mandatory behavior, safety/permission rules, and a subsystem-to-document index.
2. Move detailed subsystem implementation notes and historical measurements into topic documents.
3. Make the loading rule explicit: before touching a subsystem, read its indexed guide/spec. Preserve requirements that must always apply in the root guide.
4. Verify retrieval across representative tasks: providers, memory, TUI, checkpoints, and cross-cutting changes. Count the topic-document reads as part of the cost.

This loader currently does not implement automatic imports or directory-scoped inheritance. Adding links alone does not inject their contents; the agent must read them. If automatic scoped loading is built later, keep it in core and test instruction precedence and cache behavior.

Do not silently truncate user-authored instructions to a token cap. The current code deliberately removed such truncation. This proposal is an authored documentation restructure with behavioral validation.

**Acceptance:** smaller initial and recurring context, all mandatory constraints retained, no rise in missed subsystem rules, and lower end-to-end cost after including extra reads. Test cold sessions and warm multi-turn work separately.

## 6. Tune prompts for fewer turns, not just fewer words

The base prompt already emphasizes concise communication, independent tool batching, scope discipline, and stopping after checking the requested work. Compressing it further should preserve those behaviors.

Audit each recurring instruction for its job:

| Instruction type                    | Treatment                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| Authority, mode, permissions, scope | Preserve the contract explicitly                                                      |
| Tool calling and parallelism        | Keep concise operational guidance and representative examples                         |
| Planning and progress updates       | Avoid requiring a separate narration/todo call for trivial work                       |
| Verification                        | Ask for checks proportional to the change; avoid repeated checks without new evidence |
| Repeated style guidance             | Consolidate duplicates while preserving meaningful user-facing behavior               |
| Provider/model-specific weakness    | Use the existing small model overlay only where an eval demonstrates a need           |

A useful experimental instruction might be: “After a check passes, repeat it only when relevant code changes or new evidence invalidates the result.” Treat this as a candidate, not a new production rule. The current prompt already expresses similar constraints; first find traces where those constraints are not working.

Measure tool-free continuation turns, repeat searches, repeated unchanged reads, unnecessary planning calls, and checks rerun with no intervening relevant edit. Keep a separate category for legitimate retries or verification so useful work is not counted as waste.

Shortening a cached prompt saves its cold input/write cost and subsequent cache-read cost; it does not save full-price input on every request. Conversely, reducing one unnecessary round trip can save input, output, and reasoning together.

**Acceptance:** compare coding outcomes, parallel-batch behavior, citation quality, scope discipline, and successful stopping. Include small questions where the correct answer needs no tools and difficult changes where planning and verification are necessary.

The system-prompt edit that was uncommitted when this was written landed in `a13f0c70`. Capture the exact `system.md` at the commit you test from as the baseline, and record that commit. Do not compare against an older prompt.

## 7. Send more useful tool results with fewer tokens

The first opportunity is preventing irrelevant content from entering history:

- Prefer path/symbol search followed by a bounded read over whole-file reads when the task only needs one region.
- Return compact structured diagnostics for known test/build formats: exit status, failure names, relevant locations, and enough surrounding detail to act.
- Keep exact source and patch content when correctness depends on exact bytes.
- Preserve a full-output handle and explicit truncation notice so omitted details remain recoverable.

Extend existing read-state and output-store behavior instead of duplicating it. A repeated read after a file changes, after compaction, or after its earlier content is pruned can be necessary. The model should only receive “unchanged” when it still has a usable copy.

Do not globally turn on `FREECODE_BASH_COMPRESS=1` as a default saving: the prior experiment rejected it. A better new experiment would target one output family with known semantics and verify that failure evidence survives, then measure recovery calls.

For schemas, reduce repeated descriptions before deleting parameters or weakening their types. Mode filtering and role allowlists already reduce exposure. If a large MCP catalogue dominates, prototype discovery for optional tools with a compact stable index and recoverable access to full schemas. Measure discovery turns and prefix invalidation as well as removed schema tokens.

**Acceptance:** reduced newly injected bytes plus lower total runtime cost, with unchanged task success and no increase in retries, rereads, malformed arguments, or omitted diagnostics.

## 8. Route models and effort deliberately

There are multiple operations with different quality needs:

| Operation                       | Candidate policy                        | Validation                                                              |
| ------------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| Main coding task                | User-selected capable model as baseline | Coding success, repairs, total cost                                     |
| Simple bounded extraction       | Explicit cheaper operation model        | Fact accuracy, schema compliance, no invented memories                  |
| Compaction                      | Tested summary model, with fallback     | Preserve decisions, exact identifiers, constraints, and unfinished work |
| Verifier                        | Model chosen for defect detection       | Catch real defects without creating false failure loops                 |
| Large independent investigation | Bounded child with selected context     | Useful result versus cost of doing the work in the parent               |

Current extraction calls omit `model` and use the provider default; that default is not inherently the cheapest capable model. Subagent execution supports a model override, while the verifier passes the main provider/model. These are concrete points for an explicit operation policy. See [loop.ts](../apps/core/src/agent/loop.ts) and [subagent.ts](../apps/core/src/agent/subagent.ts).

Start with simple, inspectable rules rather than spending a model call to classify every prompt. Log the resolved operation model. Preserve a user's explicit model/effort selection unless a configured routing policy permits changes. Avoid per-turn model switching without counting new cache writes and recovery/context transfer.

[effort.ts](../apps/core/src/providers/effort.ts) already maps effort settings to provider options. Test lower effort on bounded tasks and retain higher effort where it improves success. A lower maximum output cap is not equivalent: it can truncate patches or tool arguments and provoke retries.

**Acceptance:** lower complete task cost at the required quality level, including fallback spend. For a cheap-first policy, evaluate `cheap attempt + probability of escalation × escalation cost`, then also measure failures that escape the escalation detector.

## 9. Tune compaction, memory, and cache policy together

### Compaction

The existing threshold is based on `min(context window, compact target) - buffer`, with an explicit override for testing. The target defaults to 120,000 tokens; the buffer makes the actual trigger lower. Do not describe this as “no compaction until 120K.”

An earlier compaction must recover its own summary cost, the next cache rebuild, and any rereads it causes. Use this decision model:

```text
expected future request savings
  > summary cost + prefix rebuild cost + expected recovery cost
```

Test long continuations and short sessions ending immediately after compaction. Keep pending tool relationships, recent working context, user constraints, and exact identifiers intact. The LLM summary currently has a 1,024-token output cap; reducing it blindly risks dropping critical state.

`FREECODE_COMPACT_TARGET_TOKENS` exists, but it is not currently in the paired A/B environment allowlist. Add it only after verifying per-variant isolation, or use controlled separate processes with matched workloads. Do not publish an A/B command the runner rejects.

### Memory

Keep recall as a measured capability. Candidate changes include fewer irrelevant memories, summary-only display for low-priority entries, avoiding repeat extraction of already saved facts, and explicit operation models. Existing cadence and consolidation gates already provide some of this control.

Evaluate learning, later reuse, corrections, irrelevant memories, and cross-session behavior. Use the memory suites and injection benchmark described in [EVAL.md](../EVAL.md); a smaller recall block alone does not prove a better system. Include extraction, consolidation, final flush, and judge calls in the cost.

### Prompt cache and warming

Preserve stable tool order and old message bytes. Keep changing todo/memory/reminder content in the existing ephemeral tail. Use [caching-architecture.md](caching-architecture.md) before changing request assembly.

Warming is speculative spending. The current warmer uses a fixed idle-continuation probability of 0.15 and a minimum expected saving of $0.05. Those are implementation assumptions, not measured FreeCode-wide behavior. Compare actual refresh spending with avoided misses, including sessions that never resume. Leave it off unless the relevant workload justifies it.

Changing model, prompt, cache lifetime, or tool catalogue can affect the economics. A high cache-hit percentage is not an objective by itself: caching a large irrelevant prompt can still cost more than sending a smaller useful one.

## 10. Bound repeated work without stopping useful work

Review complete trajectories for:

- The same failing tool call repeated without changed arguments or new evidence.
- Repeated subagent investigations that cover the same files and question.
- Polling a background task through extra model turns when a completion event could deliver the result.
- Verifier/repair cycles that raise new optional requirements after the requested task is already satisfied.
- Repeated continuation nudges after an unresolved blocker.

FreeCode already has loop-health detection, retry classification, capped verifier attempts, and an auto-poke policy that defaults off. Preserve successful behavior and target the observed remaining waste. [RecoveryManager](../apps/core/src/agent/recovery/manager.ts) already distinguishes quota failures from transient retries; do not propose that classification as new.

Parallel tool execution can improve latency, while multiple independent calls in one model response can also reduce round trips. Spawning multiple agents may do the opposite for dollars: each has its own prompt, exploration, and output. Use delegation where independent work or focused context earns its cost.

`FREECODE_MAX_TURN_TOKENS` is an existing opt-in backstop. The inspected loop checks aggregate input plus output after a turn's usage arrives, so it is not a strict preflight dollar cap and can overshoot by a call. It also does not substitute for complete root-task accounting. A proposed dollar budget should account for child and auxiliary operations and report incomplete work honestly when exhausted.

## 11. How to run a credible prompt experiment

Use the existing paired runner. Read [EVAL.md](../EVAL.md) before paid execution; none of the commands below were run for this document.

Prepare two complete prompt files in a temporary experiment directory: the exact current baseline and one candidate. The placeholders below must be replaced with real absolute paths:

```bash
pnpm eval ab coding \
  --baseline 'env:FREECODE_SYSTEM_FILE=/absolute/path/baseline.md' \
  --candidate 'env:FREECODE_SYSTEM_FILE=/absolute/path/candidate.md' \
  --trials 5 \
  --hypothesis 'Shorter recurring guidance reduces total cost without reducing coding success'
```

`FREECODE_SYSTEM_FILE` and `FREECODE_APPEND_SYSTEM_FILE` already exist and are allowlisted. A project/global `.freecode/SYSTEM.md` takes precedence over the experimental base file, and append files also affect the final prompt. Verify the resolved prompt differs as intended on both sides; the two filenames alone prove nothing. See [prompt.ts](../apps/core/src/session/prompt.ts) and [eval/ab.ts](../apps/core/src/eval/ab.ts).

Use `trajectory` to test tool behavior and `judged` for response quality where appropriate. The judged suite needs a separately configured judge that is not the model under test. Add long-session and representative repository workloads because small dependency-free coding fixtures do not establish real-project savings.

The paired runner interleaves variants and records provenance. Its success exit code does not mean the candidate won. Inspect per-case failures, uncertainty, unknown prices, and raw pass-count declines. Keep the existing quality gate; define a cost-saving decision on top of comparable runs rather than treating the efficiency warning as a cost gate.

Suggested experiment record:

| Field      | Record                                                                         |
| ---------- | ------------------------------------------------------------------------------ |
| Hypothesis | One proposed mechanism, declared before running                                |
| Variants   | Exact prompts/configuration and working-tree hash                              |
| Workload   | Cases, model/auth mode, cold/warm state, context size                          |
| Quality    | Per-case successes, failures, verifier/judge findings                          |
| Cost       | All known runtime operations, unknown/pending coverage, grader cost separately |
| Efficiency | Input/cache/output/reasoning, requests, repeat work, latency                   |
| Decision   | Kept/rejected/inconclusive, evidence, limitations, rollback                    |

## First implementation batch

1. Extend accounting for compaction, task-tree calls, and warming; validate pricing-policy coverage.
2. Capture the real request breakdown on representative tasks using the existing compiler segments.
3. Prototype a compact root guide with topic documents for this repository, preserving mandatory instructions and testing that the right guides are loaded.
4. A/B one prompt/tool-output improvement at a time, then test the winning combination for interactions.
5. Add operation-specific model/effort experiments only after total cost is trustworthy.

This keeps the scope broad enough to change the right part of the system while making each saving attributable and reviewable. The expected deliverable from implementation is a smaller bill for equally successful work, supported by measured results rather than token counts alone.
