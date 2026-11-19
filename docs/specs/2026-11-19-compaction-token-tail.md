# Compaction: keep the recent tail by tokens, cut once

> **Status:** Built 2026-11-19 on branch `harness-fix`; `eval ab` kept (§4.2).
> **Evidence:** session `ff9dd627` (desktop, MiniMax-M3.1-Flash), rollout
> `~/.freecode/rollout/sessions/ff9dd627-…/events.jsonl`, `compact.occurred`
> seq 1695 and 1722.
> **Prior art (local clones, read 2026-11-19):** pi
> (`packages/coding-agent/src/core/compaction/compaction.ts`, `findCutPoint`,
> `isSplitTurn`), opencode (`packages/core/src/session/compaction.ts`,
> `recentStart`, `splitConversation`).
> **Precursor (built):** `a3b0fd0b` tool images are `synthetic: "tool_image"`
> and no longer count as user turns; `f0436e9b` images estimate at 1,500 tokens.

## 0. Plain language

When the conversation gets too big, compaction summarizes the old part and keeps
the recent part word for word. Today "recent" means **the last two things the
user typed**. One prompt followed by 40 minutes of tool calls is a single user
turn, so nothing in it is ever old enough to drop: the request stays big and
the summarizer call is paid for nothing. This changes "recent" to **the last
~20K tokens**, the way pi does it, and makes the summary cover exactly what was
dropped.

## 1. What happened in ff9dd627

| | compaction 1 (01:40:22) | compaction 2 (01:41:00) |
|---|---|---|
| provider request before | 177,401 | 145,125 |
| store messages before → after | 305 → **300** | 306 → **7** |
| summary-side estimate before → after | 43,283 → 1,101 | 1,576 → 914 |

Two separate faults:

1. **The store cut has no token bound.** `keepLastNUserTurns(stored, 2)` kept
   everything since the 01:02 prompt — the whole 40-minute turn. Five messages
   went. The request barely shrank.
2. **Two cuts, made independently.** The summary is written from
   `MemoryService`'s own small transcript, cut by `selectForCompaction` with an
   8K tail. Compaction 1 summarized almost all of it while the store kept 300
   of 305 messages: the model got a summary of work still in its history.

(Compaction 2's cut to 7 was the screenshot bug, fixed in `a3b0fd0b`.)

## 2. How pi and opencode do it

| | pi | opencode | freecode today |
|---|---|---|---|
| Tail size | walk back to `keepRecentTokens` (20K) | drop oldest until `keep` (15K) fits | last 2 user turns, unbounded |
| Cut inside one long turn | yes, at an assistant message (`isSplitTurn`); the turn's start is summarized with its request | no: snaps to a user message; with one user message it summarizes everything and keeps nothing | no (headless fallback only) |
| Kept tail is | real messages | flattened text inside the summary | real messages |
| Cuts made | one | one | two, disagreeing |

opencode's flattening is the wrong fit here: `real-tool-call-after-compaction-summary`
exists because models imitate text-shaped tool calls they see after
compaction. pi keeps real messages and cuts once. **We follow pi.**

## 3. Design

### 3.1 One cut, on the real transcript (`compact-apply.ts`)

`keepRecentTokens(messages, budget)` walks back from the newest stored message
adding `estimateMessageTokens` (text/4, tool args + result, 1,500 per image)
until the total reaches `budget`, then cuts at the nearest **valid cut point** at
or after that message. A valid cut point is an assistant message or a user
message that `isUserTurn` accepts — never appended context, never a tool image
(it belongs to the tool call before it). A tool result is stored inside its
assistant message, so no cut separates a call from its result.

If everything fits in the budget, nothing is dropped and compaction reports
"nothing to compact", as today.

### 3.2 A split turn keeps its prompt

If the cut is not itself a turn start, the user message that started that turn
is kept verbatim in front of the tail — the brief that ff9dd627 lost. pi
summarizes the turn's prefix separately; keeping the prompt is simpler and is
what the headless fallback already did for `messages[0]`. A prompt larger than
the whole budget is a pasted document, not a brief, and is not pinned.

### 3.3 The summary covers exactly what was dropped (`selector.ts`)

`applyCompaction` passes the timestamp of the first kept message (after the
pinned prompt) as `cutoffTimestamp`; `selectForCompaction` then summarizes the
`MemoryService` messages older than it instead of making its own cut. Ordering
holds because within one loop iteration the store writes each tool message
before `memory.addToolTurn` records the iteration. If the cutoff selects
nothing (a transcript rebuilt by `resetTranscript` is stamped "now"), the
selector falls back to its own cut rather than skip the summary.

Known edge: a parallel tool batch is one `MemoryService` message but several
store messages; a cut inside the batch drops some of its calls from the store
while the batch's summary-side record is kept for the next compaction.

### 3.4 Budget: 20K, at most half the conversation

`keepRecentTokens` keeps `min(20_000, conversation / 2)` estimated tokens.
Compaction fires on the provider's whole request, and the system prompt and
tools are a large, fixed part of it — about 9.5K of the 12K trigger the
compaction eval cases force, about 45K in ff9dd627. A fixed 20K tail can then
hold the entire conversation and drop nothing. The first A/B (§4.1) built the
budget as `min(20K, trigger / 4)` instead and hit exactly that: 3K of tail
against a ~3K conversation, no compaction in 0/5 trials. opencode guards the
same way (`recentStart`: when everything fits, keep only the latest exchange).
A manual `/compact` therefore always drops something.

### 3.5 Switch

`FREECODE_COMPACT_TAIL=turns` restores `keepLastNUserTurns` and the selector's
own cut, for `eval ab` and rollback. Default `tokens`.

## 4. Verification

- **Unit:** the ff9dd627 shape (one prompt, hundreds of tool messages,
  screenshots) keeps ≤ budget plus the pinned prompt; cuts never land on
  context or tool images; the cutoff selects exactly the older summary-side
  messages; the scaled budget; the `turns` switch.
- **Eval:** a new `coding.jsonl` case where one prompt's work compacts inside
  that single turn and a rule stated only in the prompt must still hold at the
  end. Then `pnpm eval ab coding --baseline env:FREECODE_COMPACT_TAIL=turns
  --trials 5` on it and the three existing compaction cases; read the trace for
  the post-compaction request size, not just pass counts.

### 4.1 A/B 1 — budget `min(20K, trigger/4)`, rejected

`2026-11-19-coding-1`, MiniMax-M3, 5 trials, `turns` → `tokens`:
`long-turn-compacts-and-keeps-its-brief` 0/5 → 5/5;
`real-tool-call-after-compaction-summary` 5/5 → 0/5 and
`compaction-survives-multi-file-edit` 5/5 → 3/5, every failure "expected ≥1
compaction, saw 0". Cause in §3.4. Cost −4.2%.

### 4.2 A/B 2 — budget `min(20K, conversation/2)`, kept

`2026-11-19-coding-2`, MiniMax-M3, 5 trials, `turns` → `tokens`:
`long-turn-compacts-and-keeps-its-brief` 0/5 → 5/5; the three existing
compaction cases 5/5 → 5/5; no raw pass-count declines, no infrastructure
failures. Comparable pairs: tokens −12.3%, cost −10.4% ($0.359 → $0.322),
turns 294 → 261.

## 5. Not in this phase

- Replacing the `MemoryService` shadow transcript with the real dropped
  messages as summarizer input (removes §3.3's timestamp alignment).
- pi's separate summary of a split turn's prefix.
