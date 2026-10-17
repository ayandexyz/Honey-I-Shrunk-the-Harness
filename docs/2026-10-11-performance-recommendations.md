# Making FreeCode faster: recommendations from the Claude performance article

Date: 2026-10-11  
Reviewed checkout: `97793b1e`  
Status: recommendations based on source inspection; no performance changes or benchmarks were run for this document.

For prompt changes, token reduction, model selection, and billing efficiency, see the separate [token and cost efficiency guide](2026-10-12-token-and-cost-efficiency.md).

## Where I would start

For FreeCode, I would first measure **submit → first visible response**, improve the TUI's handling of long streaming answers, and fix incremental text display in the desktop/browser app. Then I would investigate session-history loading and checkpoint overhead on large projects.

There is enough concrete evidence to choose experiments, but not enough to promise a percentage speedup. Faster rendering, faster local preparation, and faster model generation are different outcomes. We should report them separately.

### What the article contributes

The [Claude engineering article, published September 23, 2026](https://claude.dev/blog/how-we-made-claude-ai-faster/), describes a performance sprint organized around user journeys. Its transferable method is to measure from interaction to rendered result, use repeatable local benchmarks, validate that cheaper work improves experienced latency, and protect successful changes against regressions. It also describes reducing repeated rendering work and deferring nonessential startup work. The reported roughly threefold improvement belongs to Claude's application and workload; it is not a forecast for FreeCode.

The recommendations below come from inspecting FreeCode's code. Priority reflects the strength of that evidence and the affected workflow, not measured milliseconds saved.

## Priority list

| Priority | Recommendation                                                 | Benefit to investigate                             | Evidence / effort                                                                   |
| -------- | -------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| P0       | Measure complete startup, send, resume, and rendering journeys | Identify where users actually wait                 | Existing tracing and frame statistics provide a foundation; medium effort           |
| P1       | Handle incremental text in `apps/web-app`                      | Earlier visible output in desktop/browser sessions | Missing delta handling confirmed in source; medium effort including lifecycle tests |
| P1       | Reduce repeated Markdown work in the TUI's active reply        | Smoother long answers and more responsive input    | Full active-message renderer rebuilt when dirty; medium–high effort                 |
| P1       | Isolate unchanged React messages and control autoscroll        | Less work as desktop/browser transcripts grow      | Re-render, parsing, and scrolling paths confirmed; small–medium effort              |
| P2       | Avoid reparsing unchanged session history                      | Faster follow-up sends and long-session resume     | Full JSONL read and parse on `getMessages`; medium effort                           |
| P2       | Profile checkpoint capture and reduce unnecessary work         | Faster preparation in large repositories           | Capture is awaited before the provider; medium effort, correctness-sensitive        |
| P3       | Profile packaged startup and local context misses              | Faster cold launch where local setup dominates     | Several obvious startup optimizations already exist; measure before changing        |

If the TUI is the main surface you use, prioritize its streaming renderer after P0. If you use `freecode web` or desktop, prioritize the two web-app items together. The runtime browser UI is served from `apps/web-app/dist`; optimizing the Next.js website alone would miss that path. See [web-server.ts](../apps/core/src/web-server.ts).

## 1. Measure what the user experiences

FreeCode already records provider requests, first chunks, responses, and tool activity. Start with [TRACE.md](../TRACE.md), [the recorder](../apps/core/src/rollout/recorder.ts), and [the trace fold](../apps/core/src/rollout/trace.ts).

However, `model.first_token` is recorded on the first normalized provider chunk in `AgentLoop.callProviderOnce`. That chunk need not be visible answer text, and the metric excludes preparation before `model.request` and rendering after receipt. It is useful, but it is not a measurement of when the user first sees an answer. See [loop.ts](../apps/core/src/agent/loop.ts), `callProviderOnce`.

Add explicit measurements with these boundaries:

| Journey         | Start                | End                                        | Useful breakdown                                                                  |
| --------------- | -------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| Cold startup    | Launch the process   | A typed character appears in the editor    | Entry/import work, CLI readiness, first UI render                                 |
| Send            | User submits         | First answer text is displayed             | IPC, history, hooks, checkpoint, prompt/memory preparation, provider wait, render |
| Resume          | Select a session     | Transcript is displayed and input responds | Disk read/parse, active branch selection, IPC payload, rendering                  |
| Streaming       | Receive a text delta | Updated text is displayed                  | Buffering, Markdown work, layout/render, output                                   |
| Turn completion | Backend finishes     | UI exits its working state                 | Final snapshot, bookkeeping, deliberate UI delays                                 |

Track p50, p75, and p95, separating cold/warm sessions, frontend, runtime, provider/model, auth mode, cache state, transcript size, and project size. Include a keystroke-during-streaming scenario.

Use monotonic durations inside each process. Correlate the frontend interaction with core's session, user-message entry, and inner model-call identifiers; do not subtract unrelated process clocks or confuse one model iteration with a whole user request. Add only timing, counts, and safe identifiers to rollout/OTLP data, preserving the existing omission of prompt bodies and file paths.

The TUI already exposes **Shift+Ctrl+D** frame statistics through [render-guard.ts](../apps/tui/src/render-guard.ts) and [frame-stats.ts](../apps/tui/src/components/frame-stats.ts). These cover component rendering and explicitly exclude terminal diff/write time. Extend them with a bounded duration distribution; use a PTY-based measurement for visible terminal output. Do not label the existing render duration as end-to-end frame latency.

## 2. Show web-app text as it arrives

### Observed behavior

Core emits `text_delta` and `thinking_delta` while consuming the provider stream, followed by complete `text`/`thinking` snapshots. The web-app transport forwards event payloads without translating delta names, but `handleStreamEvent` only updates text for `text` and `thinking`.

Relevant code:

- [Core loop](../apps/core/src/agent/loop.ts): `callProviderOnce` and `executeTurn`.
- [Web-app transport](../apps/web-app/src/ipc-stub.ts): `registerStreamListener` and the Tauri listener.
- [Web-app handler](../apps/web-app/src/App.tsx): `handleStreamEvent`.

The expected consequence is that visible prose waits for the completed snapshot on this path, even when core already has partial text. This is a source-based finding; confirm it with an event replay and a browser run before assigning a latency number.

### Proposed change

Track an active streaming text/reasoning part, append incoming deltas, and let the completed snapshot replace that part. Do not append both the deltas and their full snapshot, which would duplicate the answer. Preserve separate segments around tool calls and successive model iterations.

Accumulate deltas between scheduled UI updates so a burst does not cause one full store update per event. Flush pending text at completion, interruption, error, and session switch, with a bounded fallback when the document is hidden. Permission and question prompts must still appear promptly.

**Acceptance:** a fixture with a delayed final snapshot displays its initial delta early; the final transcript matches the authoritative snapshots; cancellation preserves partial output; reconnects and session switches neither duplicate nor misroute text. Compare delta-received → visible latency and input responsiveness.

## 3. Reduce work on the TUI's growing answer

### What is already optimized

[VirtualMessageList](../apps/tui/src/components/virtual-message-list.ts) caches rendered lines for settled messages above the live region, retains a bounded message window, and invalidates for width and explicit message changes. [SafeTUI](../apps/tui/src/render-guard.ts) memoizes child renders within a frame. These optimizations already have tests; adding another generic conversation cache is unlikely to be the first useful step.

### Remaining candidate

In [message-row.ts](../apps/tui/src/components/message-row.ts), `StreamingAssistantMessage.append` marks the buffer dirty. The next render calls `createAssistantMessageComponent(this.text)` with the whole accumulated answer. Deltas are already coalesced until rendering, but a dirty render still rebuilds the active message's Markdown component tree.

For a long response, repeatedly processing its growing prefix can make total work rise much faster than the final output size. Measure it with fixed output sizes and chunk schedules before changing the parser.

Prototype reuse of stable rendered regions inside the active message, with the unfinished region remaining mutable. Key cached results by content, terminal width, and presentation settings. Keep the final authoritative snapshot as a reconciliation point.

Markdown needs care: a later reference definition, fence delimiter, or table continuation can change interpretation of earlier text. Only freeze regions whose semantics are safe, or explicitly invalidate affected regions. Preserve the existing appearance, resize behavior, selection, and abort handling.

**Acceptance:** identical final rendered lines against the current renderer for representative fixtures, lower cumulative parsing/highlighting work, and lower p95 rendering cost during a long answer. Extend [streaming-text.test.ts](../apps/tui/src/components/streaming-text.test.ts), [virtual-message-list.test.ts](../apps/tui/src/components/virtual-message-list.test.ts), and [render-guard.test.ts](../apps/tui/src/render-guard.test.ts).

Start with reuse and invalidation. A worker for highlighting is a later option if profiling shows highlighting dominates enough to justify serialization, scheduling, and runtime compatibility costs.

## 4. Keep React updates local to the changed message

Three connected behaviors are visible in the desktop/browser UI:

1. [chat-store.ts](../apps/web-app/src/stores/chat-store.ts) replaces the messages array when the last part changes, while retaining older message objects.
2. [MessageList.tsx](../apps/web-app/src/chat/MessageList.tsx) maps the array into un-memoized [ChatMessage](../apps/web-app/src/chat/Message.tsx) components. [TextPart.tsx](../apps/web-app/src/chat/parts/TextPart.tsx) calls `marked.parse(content)` during rendering.
3. The list calls `scrollIntoView({ behavior: "smooth" })` whenever `messages` changes.

Memoizing message components can exploit the stable identities the store already preserves. Cache text parsing by content so status or presentation updates do not repeat it unnecessarily. Verify that text-size changes still update every visible message. These changes become more valuable when incremental text handling increases update frequency.

Autoscroll should follow new output only while the reader is near the bottom. Schedule it once per UI update, and avoid repeatedly starting smooth animations during a stream. Preserve the user's position when they scroll up.

Consider viewport virtualization only if large-transcript profiles justify it; it adds complexity around variable heights, selection, search, and scroll anchoring.

**Acceptance:** after warm-up, changing one active text part does not reparse unchanged historical text; scrolling up stays stable during incoming output; DOM size, commits, and main-thread work are measured on a long transcript. Commit counts are diagnostics, not proof of a faster experience by themselves.

## 5. Avoid loading the whole unchanged history on every send

[AgentLoop.run](../apps/core/src/agent/loop.ts) calls `loadHistory`, which calls the session store's `getMessages`. In [session/store.ts](../apps/core/src/session/store.ts), `readEntries` reads the entire messages file, splits it, and parses every entry. Branch resolution already uses a linear fast path and an ID map; there is no reason to assume a repeated linear-search bug there.

The experiment should target repeated disk reading, parsing, and message conversion across follow-up sends.

A bounded cache owned by the session store could retain parsed entries and their active path, update after successful appends, and invalidate on replacement, compaction, navigation, rewind, import, deletion, and detected external changes. Keep disk as the durable authority. Avoid returning mutable cached arrays that callers can accidentally alter.

Start by measuring this path against small and large histories. If it is significant, implement a simple validated cache before a persisted offset index or storage migration. Merely keeping an `AgentLoop` alive is insufficient if `run()` still reloads history.

**Acceptance:** repeated warm reads avoid reparsing unchanged bytes; branch navigation and compaction produce the same messages as an uncached store; external edits are observed; memory remains bounded. Record bytes parsed, entries converted, and p95 pre-provider latency.

## 6. Profile the checkpoint barrier

The agent awaits checkpoint capture before persisting the new user message and proceeding to the model. [CheckpointService](../apps/core/src/checkpoint/service.ts) reports capture duration, and [loop.ts](../apps/core/src/agent/loop.ts) records successful captures. Reuse that evidence first.

[ShadowGit.capture](../apps/core/src/checkpoint/shadow-git.ts) performs an untracked-file listing, checks file sizes, runs `git add -A` against the shadow index, and writes a tree. The size checks currently await each `stat` sequentially. On projects with many untracked files this is a specific experiment worth measuring, not proof of a bottleneck on every project.

Split capture timing into initialization, untracked scanning, size checks, staging, tree writing, and metadata persistence. If size checks dominate, test bounded parallel filesystem reads. If Git dominates, investigate its work before introducing application-level snapshot reuse.

Preserve the checkpoint's meaning: it describes files before the agent acts. Do not let mutating tools race capture. A watcher-only shortcut can miss external edits or event loss, so it needs a reliable fallback before it can skip work. Preserve the user's real Git index and the existing handling of ignored and oversized files.

**Acceptance:** lower capture latency on the affected fixture and identical snapshot/restore behavior, including external edits, additions, deletions, and large untracked files. Follow [the checkpoint spec](specs/2026-09-23-checkpoints-rewind.md) and the existing shadow-Git tests.

## 7. Preserve the speed work already present

Several broad recommendations are already implemented or need a narrower experiment:

| Area                    | Existing behavior                                                                                                                                                            | Useful next step                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider initialization | [generic-provider.ts](../apps/core/src/providers/generic-provider.ts) loads its SDK on demand                                                                                | Measure first-call initialization separately from subsequent calls                                                                             |
| Startup                 | [entry.ts](../apps/tui/src/entry.ts) lazily imports the TUI; update checks no longer block launch                                                                            | Profile the actual release binary, including its native-library re-exec, separately from `tsx` development startup                             |
| Project context         | [tree-cache.ts](../apps/core/src/context/tree-cache.ts) caches context; [session-context.ts](../apps/core/src/context/session-context.ts) freezes prompt context per session | Measure cold synchronous directory/Git work; preserve prompt-prefix stability if refactoring                                                   |
| Memory                  | [graph/index.ts](../apps/core/src/memory/graph/index.ts) uses background retrieval and a 60 ms cold wait budget                                                              | Measure actual cold-path blocking and retrieval quality; a timer budget does not bound synchronous event-loop work                             |
| Tool execution          | [batching.ts](../apps/core/src/tools/batching.ts) already groups concurrency-safe calls                                                                                      | Measure actual batch overlap and dependency waits; keep writes, hooks, and permission ordering correct                                         |
| Prompt caching          | Stable context and frozen pruning decisions already protect reused prefixes                                                                                                  | Track cache reads alongside first-visible latency; use [caching-architecture.md](caching-architecture.md) before changing request construction |

Do not make disabling memory, checkpoints, or permission checks the default performance solution. They provide behavior users depend on. Changing model, effort, prompt contents, or compaction policy also needs a quality comparison: reduced elapsed time is not a win if more tasks fail or need follow-up turns.

The packaged CLI uses Bun, and the desktop uses Tauri. Runtime-specific V8/Electron tricks from the article should not be assumed to transfer to either. Likewise, a static HTML composer is a lower priority than measuring startup and fixing the visible-output path already identified here.

## A practical implementation sequence

### First change: a baseline and repeatable fixtures

Add a small local performance harness with deterministic input/event fixtures. Suggested fixtures are proposals, not existing commands:

- Short and long transcripts, including branching and large tool results.
- A long Markdown reply with code fences, tables, Unicode, and different chunk sizes.
- A session switch, interruption, final-snapshot reconciliation, and reconnect during output.
- Small/large Git repositories with tracked, ignored, and untracked files.
- Typing and scrolling during output; cold and warm startup in the packaged binary.

Reuse the [TUI end-to-end harness](../apps/tui/e2e/tui-session.ts) where appropriate. A synthetic frontend event replay should be a local test/benchmark, not an `evals/*.jsonl` case: those cases run real agent turns. Existing rollout logs omit message bodies, so they cannot reconstruct a text-rendering fixture by themselves.

Record checkout, runtime, hardware, fixture hash, and configuration. Run paired before/after measurements on the same machine with warm-up and enough repetitions to show variation. Keep local rendering measurements separate from real-provider runs; live provider latency is noisy and paid.

### Next changes: one measurable improvement each

1. Add delta/snapshot handling and local React update isolation together for the web-app, with separate reviewable changes if useful.
2. Prototype the TUI active-message optimization and compare identical output fixtures.
3. Implement a history cache only if the new preparation timings show meaningful repeated work.
4. Optimize checkpoint scanning or startup only where the profiles justify it.

For each change, record the user-facing metric, local work metric, correctness result, and memory/cost tradeoff. Keep a small performance result beside the relevant benchmark so future changes can be compared.

### Protect proven improvements

Use deterministic checks for stable invariants: unchanged message parse counts, child-render reuse, final transcript equality, and cached-versus-uncached history equality. Use repeated timing measurements with sensible tolerances for wall-clock performance; do not gate every PR on a single noisy millisecond threshold. Instruction-count tools can be explored later for isolated pure-JavaScript paths if their results prove useful on the runtime being tested.

When a change affects what the model sees or does, consult [EVAL.md](../EVAL.md) and run an appropriate quality comparison. Memory changes also have the existing `bench:recall` and `bench:inject` entry points. Frontend-only rendering improvements should not require paid agent evaluations merely to demonstrate fewer renders.

## What you can inspect now

These existing commands read local trace data:

```bash
freecode trace --list
freecode trace <session-id>
freecode trace <session-id> --json
freecode trace <session-id> --slow 5000
```

The `--slow` view hides the tool waterfall; use the ordinary trace or JSON output when comparing model and tool time. The remainder labeled `other` can include idle or user-input time, so do not treat all of it as harness overhead.

In the TUI, open **Shift+Ctrl+D**, stream a long answer, and compare rendering statistics with a short transcript and a long one. This is a useful first observation; the fixtures above are how to turn it into a reproducible result.

My first implementation choice would be the baseline instrumentation plus the TUI streaming experiment for daily CLI use. For desktop/browser use, the missing delta handler is the clearest immediate opportunity because the backend already supplies the data required to show an earlier response.
