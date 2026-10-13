# Stuck-Loop Recovery: repeated errors, and rereads after compaction

> **Status:** Draft (2026-10-13). Phase 0 (measurement) is built and is what
> this spec is derived from. **Phase 1 (calibration) done 2026-10-13, §5.1.1:
> threshold 5**, plus a fourth rule (count only across edits) the data forced.
> **Phase 2 built 2026-10-13**: signal E in core (`agent/repeated-error.ts`,
> `effect/loop-health.ts`), **warn-only** (owner decision: neither claude-code
> nor opencode ever stops a run on its own, and no recorded run reached a stop
> threshold), the §4.2 reminder, and `loop.warned` (§4.5). `eval ab` §5.2.1.
> **Phase 3 built 2026-10-13** (§4.3.1): the unchanged-read stub already
> existed (`tools/read-state.ts`, RC5) — the spec was wrong — but compaction
> never ended it, so 89 of 100 stubs in the long-task run pointed at content
> the summary had replaced. Fixed, plus the post-compaction restore. Phases 4–5
> not built.
> **Branch:** `fix/stuck-error-recovery`.
> **Evidence:** `bench:pathology` (`bench/harness-signals/pathology.ts`,
> HARNESS-BENCH.md §3b), the long-task run in
> `bench/agent-bench/results/pathology-commits-v2/`, user session `6d4b1c74`.
> **Prior art (local clones, read 2026-10-13):** opencode
> (`~/Projects/githubProjects/agents/opencode`), claude-code (`…/claude-code`),
> pi (`…/pi`), oh-my-pi (`…/oh-my-pi`), grok-build (`…/grok-build`). File
> references below are relative to those roots.
> **Related:** `2026-08-26-trajectory-redirection.md` (redirect, off by default),
> `2026-09-12-harness-bench.md` (signals, auto-poke), `effect/loop-health.ts`.

---

## 0. Read this first (plain language)

Sometimes freecode keeps busy for many minutes without getting anywhere. It
edits, runs the type checker, gets the **same error back**, edits again, runs
the checker with a different `grep`, dumps the file byte by byte with `od -c`,
and so on. Nothing in the harness notices. Every stuck detector freecode has
looks at what the model **sends** (identical calls, no file changes, edits that
undo edits). In this failure the calls differ every time and the files do
change. Only the **result** stays the same.

This spec adds the missing detector (the same error coming back) and gives the
model one specific nudge when it fires. It also adds two things claude-code does
to stop the model rereading files it already read before a compaction.

Nothing here changes a correct run. Every threshold is calibrated offline on
recorded runs before it ships, and each change is measured with `eval ab`.

---

## 1. Problem

### 1.1 What the data shows

`pnpm bench:pathology` over 12,378 recorded runs (user prompts), plus nine
isolated long-task trials (`freecode-commits` set, MiniMax-M3, freecode 0.44.0):

| Case | What happened | Cost |
|---|---|---|
| `implement-night-morning` v2 t1 | the same 4 tsc parse errors (`report.ts(412,2): TS1110`, `TS1161 Unterminated regular expression literal`, same pair in `status.ts`) came back **8 times** while the agent kept editing; in between: `awk 'NR==175' \| od -c` (twice), `/*` scans with awk, ad-hoc `node -e` parsers | 41.8 min vs 17.9 and 19.8 for t2/t3 of the same task: **2.2× time, 2.2× cost**, same end result |
| user session `6d4b1c74` run 7 | one `TS2345` at `logo-header.ts:209` seen 4 times: `tsc` re-run 3× with different `grep` filters instead of reading line 209, a guess-fix that moved the column 88→78, then a char-by-char `awk` dump of the line | ~1.5 of 8.2 min |
| same run | `/tmp/render-logo*.mjs` probe scripts that cannot resolve the repo's `node_modules` (`strip-ansi`, `string-width`), then a search through `node_modules/.pnpm` | ~1.2 min |
| every long trial | **rereads after compaction**: 24 of 25 rereads in v2 t1 (5 compactions), 18 of 18 in t2, 10 of 14 in t3 | small per read, grows with each compaction |

None of the stuck stretches tripped loop-health, because none of its signals
applies (§1.2). Measured compaction itself is healthy on real long tasks
(61–67% input shrink per compaction, no compaction loops); the earlier ~5%
figure was the tiny-threshold eval case.

### 1.2 Why loop-health is blind to it

`effect/loop-health.ts`, fed by `updateLoopHealth` in `agent/loop.ts`:

| Signal | Fires on | Why it stayed silent |
|---|---|---|
| A `repeated_identical_tool` | same tool + byte-identical args ×3 | each `tsc` had a different pipe/filter |
| B `no_progress` | 5 turns with no file change | the model kept editing |
| C `oscillation_detected` | edits that revert earlier edits | edits moved forward, they just did not fix it |
| D `repeated_reasoning` | near-identical reasoning across turns | reasoning varied |

All four key on the model's input to the tools, or its reasoning. **None reads
tool output.** And with `redirect.enabled` off (the default), only A reaches the
model at all, through `repeatedCallReminder` (`agent/reminders.ts`).

---

## 2. Goal

### 2.1 Success criteria

1. A run whose bash output repeats the same error set gets **one** specific
   nudge at the 3rd repeat, quoting the error and pointing at the location it
   names.
2. On the recorded history, the detector fires on the known stuck runs and on
   **no run that a reader would call healthy** (§5.1). Ship nothing that fails
   this.
3. Long-task rerun (§5.3): `stuck_error` repeats and minutes per trial drop on
   the stuck task with no loss of passing checks; rereads after compaction drop.
4. `eval ab` per EVAL.md shows no regression on trajectory/coding suites.

### 2.2 Non-goals

- Changing what the model is (MiniMax-M3 will keep reaching for `od -c`).
- Server-side or reasoning-stream loop detection (grok-build, oh-my-pi
  thinking-loop). freecode's D covers reasoning repetition across turns; a
  streaming runaway guard is a separate spec if the data ever shows one.
- Turning trajectory redirection on. This is a static reminder, like A's.
- Asking the user. Overnight runs (`freecode night`) have nobody to ask.

---

## 3. Prior art

### 3.1 Survey

| Agent | Detects | Signal | Response |
|---|---|---|---|
| opencode, last version with it (`44b6938b2a^:packages/opencode/src/session/processor.ts:29,356–380`) | 3 identical tool calls in a row | calls | `permission.ask({ permission: "doom_loop" })`: the **user** decides ("Continue after repeated failures") |
| opencode, current (`packages/opencode/src/session/processor.ts:29,356–380`; `agent/agent.ts:121`) | **still there** (corrected 2026-10-13 against `~/Project/githubprojects/opencode`): 3 consecutive identical tool calls | calls | `permission.ask("doom_loop")`, default `"ask"` — the user decides. Separately, `packages/core/src/session/runner/max-steps.ts` caps steps: tools disabled, model must summarise done / left / next |
| claude-code | no loop detector; `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` (`services/compact/autoCompact.ts:70`) is a compaction circuit breaker | — | — |
| claude-code (`services/compact/compact.ts:122–124,1415–1464`) | n/a — **post-compact file restore** | read-file state | re-attach the 5 most recently read files, ≤5K tokens each, 50K total, skipping files still in preserved messages |
| claude-code (`tools/FileReadTool/prompt.ts:7`, `FileReadTool.ts:564`) | n/a — **unchanged-read stub** | read-file state | a re-read of an unchanged file returns "File unchanged since last read… refer to that instead of re-reading"; state is cleared at compaction |
| pi | nothing | — | — |
| oh-my-pi (`packages/ai/src/utils/tool-call-loop-guard.ts`) | identical canonicalised calls on N consecutive turns (intent field ignored, keys sorted) | calls | corrective that **quotes the last result** (200 chars) and the args (`prompts/system/tool-call-loop-redirect.md`); **if it repeats after the corrective, abort** (`coding-agent/src/advisor/loop-guard.ts`) |
| oh-my-pi (`packages/ai/src/utils/thinking-loop.ts`) | reasoning runaways: exact suffix cycles, near-duplicate paragraphs (word-trigram Jaccard), progress-filler with no concrete anchor | model text | discard and resample; **calibrated on 13.5k non-loop thinking blocks, zero false positives** |
| grok-build (`xai-grok-sampler/src/doom_loop_recovery.rs`, `xai-grok-config/src/remote_settings.rs:14–60`) | output tail repetition over a 1K-token window, **detected by xAI's server** (`x-grok-doom-loop-check` header) | model text | resample ≤2/turn with a `<system_reminder>`; plus a "reason briefly" reminder after a >1K-token reasoning step |
| **freecode** (`effect/loop-health.ts`) | A–D in §1.2 | calls, reasoning | A: one reminder, stop at 2×; B–D: warn to redirect (off) |

### 3.2 What we take

1. **Nobody watches tool output for a repeated error.** That detector is new
   here; the evidence is §1.1.
2. **Quote what keeps coming back** (oh-my-pi). The nudge carries the error
   itself and the location it names, not "you are looping".
3. **One corrective, then escalate** (oh-my-pi; matches A's warn → stop at 2×).
4. **Calibrate offline to zero false positives** (oh-my-pi's 13.5k-block
   method). We have 12k recorded runs and a pure fold to replay them.
5. **Post-compact restore + unchanged-read stub** (claude-code), which freecode
   has neither of (`tools/read*`, `compaction/` have no equivalent).

### 3.3 What we do not take

- Asking the user (opencode): blocks unattended runs, and in the interactive
  case the user is the one being spared the loop.
- Resampling (grok-build, oh-my-pi): the stuck turns here are valid turns with
  tool calls; resampling one changes nothing about the next.

---

## 4. Design

### 4.1 Signal E: `repeated_error`

**Fingerprint.** Shared with `bench/harness-signals/pathology.ts`
(`errorFingerprint`), moved to core so the scorer and the loop cannot drift:
the error-looking lines of one **bash** tool output (`error TS\d+`, `not ok`,
`\bFAIL\b`, `XError: <message>`, `✖`), timings stripped, de-duplicated, sorted.
`read` output is never fingerprinted: it is file content, not a result (the
scorer's `except ValueError:` false positive).

**Per line, not per output.** A full test run repeats every pre-existing
failure (the three offline `modelSupportsImages` / `providers.list` tests,
TODO.md) on every run. Counted as one fingerprint per output, any long task
that runs the whole suite would trip the detector on errors the agent neither
caused nor can fix (`add-agent-control` v2 t1: `not ok 976 - modelSupportsImages`
on every run, next to a real 5-time `not ok 709`). So count **error lines**,
and drop a line from consideration once it is known to be **baseline**: present
in the run's first output of that command, before the run's first edit. Only
lines that appeared after the agent started changing things can be "stuck".

**State.** `SessionState.loopHealth.repeatedErrors`: per error line, how many
times it has appeared this run. Unlike A–C it is **not** reset by edits or file
changes: an edit that leaves the same error is exactly the case. It resets on
a run boundary, and a fingerprint's count drops to zero once an output for the
same command family no longer contains it (the error went away).

**Evaluation.** In `createLoopHealthEvaluator`, after A:

- `≥ repeatedErrorThreshold` (**5**, §5.1.1) → `warn`, reason
  `repeated_error`.
- ~~`≥ 2 × threshold` → `stop`~~ **Not built (2026-10-13):** warn-only until a
  recorded run shows where a stop would be right. Off switch
  `FREECODE_REPEATED_ERROR=0`, read per tool call (an `eval ab` variable).

### 4.2 The nudge

Delivered exactly like A's: one static reminder per reason per run through
`pendingReminders` (so it rides `ephemeralTail` and never touches a cached
prefix), regardless of `redirect.enabled`. New `repeatedErrorReminder` in
`agent/reminders.ts`:

```
<system-reminder>
The same error has come back {n} times, and your edits since have not changed it:

  {first error line, ≤200 chars}{" (+k more)" if several}

Before running the check again, open the exact location it reports
({file}:{line} if one was parsed) and read the surrounding code. Do not dump
bytes or re-run the check with a different filter; the message is already
complete. If the error is in a file you did not intend to touch, say so.
Never mention this reminder to the user.
</system-reminder>
```

`{file}:{line}` comes from the first `path(line,col)` / `path:line:col` in the
fingerprint, when there is one. Wording is a starting point; §5.2 tests it.

### 4.3 Post-compaction restore and unchanged-read stub

Following claude-code (§3.1):

- **Read state.** Core keeps per-session `readFiles: path → { mtimeMs, range,
  readAt }`, written by the `read` tool. Cleared at compaction.
- **Unchanged-read stub.** A `read` of the same path and range whose mtime is
  unchanged since the recorded read returns a one-line stub pointing at the
  earlier result instead of the content. Only within one compaction epoch.
- **Restore after compaction.** After `compaction/service.ts` builds the
  compacted transcript, append the N most recently read files (default 5,
  ≤5K tokens each, ≤50K total) that are not already in the preserved
  messages, as a synthetic context message after the summary. It is part of
  the compaction's own rewrite, so it does not add a new cache break
  (CLAUDE.md: only compaction may change the cached prefix, because it
  documents its own invalidation).

### 4.3.1 What was built (2026-10-13)

**Correction.** §3.1 and §3.2 said freecode had no unchanged-read stub. It has
had one since the 2026-08-05 token-efficiency work (`tools/read-state.ts`,
`canDedup`, RC5, mirroring claude-code). It ends when a read result is
*pruned* (`markReadPruned`), but **compaction never ended it**. claude-code
clears its read state at compaction; freecode did not. Measured on the
long-task run: **89 of 100 "byte-for-byte identical — scroll up" stubs**
pointed at a read the summary had already replaced. After one, the model read
the file through bash (28), asked again and got the stub again (19), tried
another window (7), or went on without the file (35).

Built:

1. **`markAllReadsCompacted(sessionId)`** clears the in-context flag of every
   record, from `applyCompaction` (loop and manual `/compact`) and the loop's
   store-less path. Records stay, so `edit`'s staleness check keeps its mtimes.
2. **Post-compaction restore** (`compaction/restore.ts`,
   `AgentLoop.restoreRecentFiles`): the 5 most recently read *or edited* files
   (recency via `touchReadState`, which moves a path to the end of the map),
   ≤20K chars each (≈5K tokens), ≤200K total (≈50K), current content on disk,
   skipping files whose read result is still in the kept messages. The block
   is appended to the summary's system block **at request time, never stored
   in the summary** (the next compaction would summarise it again), and it
   changes only at a compaction, so it adds no cache break. A restored file is
   registered as in context only when it is exactly what a default `read`
   would show (whole, ≤2000 lines, no line over 2000 chars); otherwise a
   re-read returns the real file. `compact.restored { files, tokens }` is
   recorded, never paths. Not persisted: after a restart the read state is
   gone too, so the model simply reads again. Off: `FREECODE_COMPACT_RESTORE=0`
   (per compaction, `eval ab`-able).

### 4.4 Scratch scripts (lower priority)

One line in the bash tool description or system prompt: put probe scripts
inside the project (or `cd` into it) so imports resolve; `/tmp` cannot see the
project's `node_modules`. Measure before keeping it: it costs prompt tokens on
every turn.

### 4.5 Recording

Today a loop-health warn leaves no event of its own: with redirect off it
records `redirect.skipped { reason: "disabled" }`, which does not say which
signal fired, and a stop shows only as the run ending. Add `loop.warned` and
`loop.stopped` (`turnId`, `reason`, `count`) for every signal, A–E, so
`bench:pathology` can fold "the nudge fired" and "did the error clear after
it" from the log. Plus `compact.restored` with file count and tokens (never
paths, matching checkpoints). The fingerprint text never
enters the rollout log: it can contain paths and source, and OTLP export must
stay leak-free; record its hash and count only.

---

## 5. Measurement

### 5.1 Offline calibration (free, before any code ships)

Replay `bench:pathology` over all recorded runs with the core fingerprint and
thresholds 2, 3, 4, 5. For each threshold list the runs it fires on and
classify them by hand (sample if many): **stuck** (same error, no change in
approach) vs **legitimate** (a hill-climb verifier failing while the solution
genuinely improves, a pre-existing failure the task did not touch). Ship the
lowest threshold with **zero legitimate hits in the sample**, as oh-my-pi did.

Calibration set from the long-task run (`pathology-commits-v2`): **should
fire**: `implement-night-morning` t1 (same tsc parse errors ×8),
`add-agent-control` t1 (`not ok 709` ×5 in two minutes). **Should stay
quiet**: `fix-night-envelope` t1 (errors keep *changing* — slow progress, not a
loop) and every trial's repeats of the 3 baseline test failures (§4.1).
Its `search_circles` flag is **not** a loop either: the bench image has no
ripgrep, so every `grep` tool call returned `Executable not found in $PATH:
"rg"` (88/88 across the run) and the model resent it. Install `rg` in the
image before the §5.3 rerun, or the before/after comparison carries that
handicap on one side only.

Known legitimate shape to exclude: jcode-bench climbs (`3e5f45bf`, `401d8104`)
repeat `grade: FAIL (verification)` while the score improves. Candidate
exclusion: the fingerprint must contain a location (`file:line`) or a test
name, which a bare verifier verdict does not.

### 5.1.1 Result (2026-10-13)

Built as `bench/harness-signals/repeated-error.ts` (pure, event-fed, unit
tested; Phase 2 moves it into core) and `pnpm bench:pathology --calibrate`,
which prints hits per threshold and the top line per run.

**The data forced a fourth rule: a line counts again only if a file changed
since it last counted.** Without it most "repeats" were one failure read
several times with no edit in between (`grep -A30 "not ok 709" /tmp/full.log`
four times in 30 s in add-agent t1), which is investigation, not "edited and
got the same error back". The baseline rule also had to widen: a line in a
command's **first full (unpiped) run** is baseline even after edits, because
agents edit before they first run the suite.

| Set | Runs | ≥2 | ≥3 | ≥4 | ≥5 | ≥6 |
|---|---|---|---|---|---|---|
| Long-task v2 (9 trials) | 18 | 6 | 5 | 3 | 2 | 0 |
| SWE-bench control (`pathology-11019`) | 3 | 0 | 0 | 0 | 0 | 0 |
| Local history (pruned since the spec's 12K scan) | 2,915 | 3 | 0 | 0 | 0 | 0 |

Long-task hits, classified by hand (count = edit-separated repeats):

| Trial | Count | Line | Verdict |
|---|---|---|---|
| implement t1 | 5 | `report.ts(412,2): error TS1110` (+3) | **stuck** — the §1.1 case |
| fix-envelope t1 | 5 | `not ok - outward-facing and system commands are refused` | **stuck** — one test failing through 6 edits over 6 min |
| add-agent t3 | 4 | `not ok - agents.stop threads the caller through…` | **stuck** — the agent's own regression, never fixed, shipped (§3.3 of the results doc) |
| add-agent t3 | 4 | `not ok - providers.list only offers…` | **legitimate** — pre-existing offline failure; every command was piped, so no "first full run" ever made it baseline |
| fix-envelope t3 | 3 | `not ok - normalizeBashForDeny strips…` | legitimate — fixed on the 3rd try within a minute |
| implement t3 | 3 | `not ok - generateReport reports the wait count…` | legitimate — ordinary test-fix cycle |
| implement t2 | 2 | `run-store.ts(175,15): error TS2677` | legitimate |

Two of §5.1's expectations were wrong: **add-agent t1 does not fire** (its
`not ok 709` ×5 were re-reads, 1 edit-separated occurrence), and
**fix-envelope t1 does** (its errors did not keep changing: one test failed
through six edits).

**Chosen: threshold 5**, the lowest with zero legitimate hits (at 4 the
pre-existing `providers.list` failure crosses). It fires on implement t1 and
fix-envelope t1 only, and on nothing in the control or the local history.
Known gaps for Phase 2: n is small (9 trials); the pre-existing-failure rule
cannot see a failure first shown through a pipe; the three offline tests are
fixed (`a83abf4d`), so this run's only baseline false positive is gone from
newer parents but the shape is not. The stop at 2× (10) is never reached in
any recorded run, so it is uncalibrated; consider warn-only until it is.

### 5.2 `eval ab`

Per EVAL.md for a loop change. Add a coding case reproducing §1.1: a fixture
with a TS parse error whose obvious fix is on the reported line, `verify` =
`tsc` passes. Today's behaviour should show repeated fingerprints; the case
scores the outcome, the trace shows whether the nudge fired.

### 5.2.1 Result (2026-10-13)

`pnpm eval ab coding`, `FREECODE_REPEATED_ERROR=0` vs `1`, 5 trials, all 14
cases incl. the new `fix-the-reported-parse-error`, MiniMax-M3, commit
`aead5844`. Ledger `2026-10-13-coding-1..4`, all **kept**.

- **14/14 cases pass with E on; no regression.** Run first as 3 parallel
  shards: every trial that completed passed on both sides, but running three
  at once hit MiniMax's Token Plan rate limit twice ("rate limit reached
  (2062)", 12:45 and 12:57), leaving 7 cases inconclusive. Rerun one at a time
  (`coding-4`): 7/7 unchanged-pass, 0 infrastructure failures. **Do not shard
  `eval ab` on this plan.**
- **E fired in 0 of 210 trials** (`loop.warned` folded from every trial's
  rollout): no false alarm. It also never fired on the new case — the model
  read the reported line and fixed it in under 5 tries — so these short cases
  prove safety, not benefit. Benefit is Phase 4's question.
- Cost: rerun comparable pairs tokens −5.3%, cost −1.0%, turns 231 → 221
  (noise level). Whole A/B ≈ $1.4.

### 5.3 Long-task rerun

Same three tasks × 3 trials, same model, after a release + `pnpm bench:image`.
Compare per trial: minutes, `stuck_error` repeats, rereads and rereads after
compaction, cost, final checks vs the parent-commit baseline (3 pre-existing
offline failures, TODO.md). n=9 is small: report each trial, not a mean.

---

## 6. Phases

| Phase | Content | Gate |
|---|---|---|
| 0 | `bench:pathology`, isolated rollout capture, long-task run | **built** (`b14585cf`, `41671218`) |
| 1 | §5.1 calibration report; threshold + exclusion chosen | zero legitimate hits in sample — **done 2026-10-13: threshold 5 (§5.1.1)** |
| 2 | Signal E + reminder (§4.1–4.2), unit tests next to `loop-health.ts` | `eval ab` §5.2, no regression — **built 2026-10-13, warn-only** |
| 3 | Unchanged-read stub + post-compaction restore (§4.3) | `eval ab` incl. `compaction-boundary`; cache-miss detector shows no new `harness:*` misses — **built 2026-10-13 (§4.3.1)**, A/B pending |
| 4 | Release, rebuild image, §5.3 rerun | numbers in this spec |
| 5 | §4.4 scratch-script line | `eval ab` |

---

## 7. Open questions

1. Should E also fingerprint non-bash tools that return errors (MCP tools,
   `lsp` diagnostics)? Start bash-only; widen if the history shows misses.
2. Does the stub (§4.3) confuse models that re-read on purpose after a
   compaction they cannot see? claude-code clears its state at compaction for
   exactly this reason; we do the same, so the first post-compaction read is
   always real.
3. Is 5 files / 50K the right restore budget at freecode's compaction target?
   claude-code's numbers assume its own window; measure the compaction ratio
   with restore on before keeping them.
4. Should a `stop` on `repeated_error` in `freecode night` count as an
   iteration failure (reset) or a `needs_human` item? Probably the latter.
