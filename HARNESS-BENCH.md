# Harness bench — command reference

> Operator's guide to the **harness signals** and **optimisation task**
> benchmarks that feed `/bench` on the website: what each command does, which
> flag to reach for, and when to run it. Design lives in
> `docs/specs/2026-09-12-harness-bench.md`; this is the "what do I
> type" page.
>
> Modelled on [jcode.sh/bench](https://jcode.sh/bench): the same six things
> jcode measures itself on, measured here — resource efficiency, agent
> comparison, an uncontaminatable optimisation task, confidence stepping,
> hill-climbable goals, auto-poke.

| Question | Command | Cost | Doc |
| --- | --- | --- | --- |
| How much RAM, how fast to first frame? | `pnpm bench:memory` | free | `Benchmark.md` |
| Does it fix real bugs vs Claude Code / OpenCode? | `pnpm bench:agents` | paid | `AGENT-BENCH.md` |
| **How far can it climb an optimisation task?** | **`pnpm bench:jcode`** | paid | **§2** |
| **Does the model step its confidence, rate its goals, finish its lists?** | **`pnpm bench:signals`** | free | **§3** |
| **Where did a run waste its time (no edits, rereads, compaction loops, hangs)?** | **`pnpm bench:pathology`** | free | **§3b** |
| Did my last change make *our* agent worse? | `pnpm eval` | paid | `EVAL.md` |

Everything on this page publishes into `apps/web/app/data/` and appears on
`/bench` by existing. `/benchmark` (the agent comparison) is unchanged and
linked from the hub.

---

## 1. The three gates (core, off by default)

`apps/core/src/agent/signals/`. The todowrite tool now takes two optional
0–100 scores per item — `confidence` and `hillClimbability` — and the loop can
act on them, plus poke a model that stops with todos open. **All three gates
are off** until `/bench` shows they should not be; the *recording* is always
on, so the bench can compare across the flip.

| Gate | What it does when on | Setting (`~/.freecode/settings.json` or `<project>/.freecode/settings.json`) | Env |
| --- | --- | --- | --- |
| Auto-poke | model stops with an **in-progress** todo → an explicitly automatic user-role reminder (`synthetic: "auto_poke"`) nudges only work within the user's request. Pending plans/suggestions alone never trigger it. Cap 3/run; unchanged open ids/statuses stop it after at most one prose-only retry; read-only modes, blocked lists and exhausted turn budgets skip it. Notices explain pokes and stops. Todo status is not authorization. | `"signals": { "autoPoke": { "enabled": true, "maxPerRun": 3 } }` | `FREECODE_AUTO_POKE=1` |
| Confidence gate | an item completed with confidence +40 or more in ONE call → reminder to go verify | `"signals": { "confidenceGate": { "enabled": true, "spike": 40 } }` | `FREECODE_CONFIDENCE_GATE=1` |
| Hill-climb gate | an item rated below 90 → reminder to reframe into something with a check | `"signals": { "hillClimbGate": { "enabled": true, "threshold": 90 } }` | `FREECODE_HILLCLIMB_GATE=1` |

Env beats files in either direction (`=0` switches off). Subagents never poke
or get gated — their parent judges their stop. No gate makes a model call.

Rollout events: `poke.triggered` / `poke.skipped` (`disabled`, `nothing_open`,
`cap_reached`, `no_progress`, `no_budget`) on every stop with a list present, and
`todo.signal` (`confidence_spike` / `hill_climb_low`, with `gated`) on every
signal. **Item text never enters the log** — ids only, joinable to the
`function.call` args.

**Flipping a default is an `eval ab` decision** (EVAL.md), not a `/bench`
one: the page shows what happened, the eval shows whether it was better.

---

## 2. Optimisation task — `pnpm bench:jcode`

jcode bench v1's three tasks (`float-print`, `json-unescape`,
`utf16-transcode`), taken **unmodified** from the public
[1jehuang/jcode-bench](https://github.com/1jehuang/jcode-bench) so the numbers
sit on jcode's axis. The agent gets a working, tested C implementation, an
exhaustive verifier and a deterministic cost model (callgrind instruction
count), and is told to make it faster. Score = `log2(given / yours)`.

```bash
# needs: cc, python3, valgrind   (Arch: sudo pacman -S valgrind)
export MINIMAX_API_KEY=$(node -p "require(process.env.HOME+'/.freecode/config.json').providers.minimax.apiKey")

pnpm bench:jcode --tasks utf16-transcode --agents freecode --trials 1     # smoke
pnpm bench:jcode --agents freecode,claude-code                            # all three tasks
FREECODE_AUTO_POKE=1 pnpm bench:jcode --tasks utf16-transcode             # with a gate on — labelled on the page
```

| Flag | Default | Does what |
| --- | --- | --- |
| `--tasks` | every task upstream | comma-separated task ids |
| `--agents` | `freecode` | adapter ids from `bench/jcode-bench/agents/` (same JSON shape as agent-bench; **no `--max-turns`** — the climb is the point) |
| `--trials` | `1` | per (task, agent). jcode's own variance note: run-to-run spread ≈ 0.1, so a single-cell gap under that says nothing |
| `--timeout` | 2h | wall-clock cap on the agent. Time is **recorded, not judged**: a timed-out run's submission is still graded, and marked † |
| `--no-full-gate` | off | skip `--full` on the final grade (float-print's full gate checks all 2³² floats and takes a while) |
| `--final-timeout` | 1h | cap on the full final gate. Past it the harness grades the **sampled** gate instead and flags the row (`finalTimedOut`, ‡ on the page) — a slow verifier is not a wrong submission. float-print's 2³² gate took over an hour here. Finish it later with `pnpm bench:jcode:regrade results/<run>` (no cap, free) |
| `--no-meter` | off | skip the recording proxy (adapter debugging only) |
| `--fresh` | off | empty the task's page file before publishing |
| `JCODE_BENCH_DIR` | `.cache/upstream` (cloned on first run) | a local checkout of the task repo, for offline runs or a pinned commit |

Per trial: the task is staged fresh into a tmpdir, the agent runs **in the
task directory** with one prompt (`runner/prompt.ts`, identical for every
agent), every `./grade` it runs appends to `scores.jsonl`, and when it exits
the harness runs the **official final grade** on the submission as left. Then
the meter is folded (tokens, USD, audit — same proxy and rate card as
agent-bench) and the run is published.

- `best` = the highest sample the agent saw during the climb. Shown, never
  ranked: not every sample runs the full gate.
- `final` = the harness's own grade afterwards. **Ranks.** `null` when the
  final verification failed — a wrong submission has no score, and the run
  exits non-zero.
- The curve on the page is the running best against active time (ms from
  agent start to the last grade), downsampled to the points where it moved.

Artifacts (git-ignored): `bench/jcode-bench/results/<run>/<task>/trial-N/<agent>/`
— `prompt.txt`, `argv.json`, `stdout.log`, `stderr.log`, `scores.jsonl`,
`submission.diff`, `final-grade.log`, `proxy.jsonl`, `usage.json`,
`audit.json`; plus `report.json` at the run root. Published (committed):
`apps/web/app/data/jcode-bench/<task>.json` — every run kept, keyed by
(runId, agent, trial). Re-publish an old run without paying, or finish its full gates:

```bash
pnpm bench:jcode:publish bench/jcode-bench/results/<run> [--fresh]
pnpm bench:jcode:regrade bench/jcode-bench/results/<run> [--task T] [--agent A] [--all]   # full gate, no cap, rewrites report.json + republishes
```

`regrade` rebuilds each trial's workspace from the artifact's `submission/`
(kept whole since the first run; older runs fall back to `submission.diff`)
and runs `./grade --full`. By default it takes trials whose final grade timed
out, failed, or was sampled; `--all` regrades everything.

**No isolation yet.** The agent runs on the host, so the proxy sees only what
is pointed at it (AGENT-BENCH.md §3) and the network is open. Recorded as
such; the container path is agent-bench's to lend (spec §6).

---

## 3. Harness signals — `pnpm bench:signals`

Free. Folds every recorded session's rollout log
(`~/.freecode/rollout/sessions/*/events.jsonl`) into one file the page reads:

```bash
pnpm bench:signals                 # → apps/web/app/data/harness/signals.json
pnpm bench:signals --since 30      # sessions that started in the last 30 days
pnpm bench:signals --rollout-dir D # another log root (a bench HOME, an eval sandbox)
pnpm bench:signals --json          # print, don't write
```

What it reports, and where each number comes from:

| Section | Number | Source |
| --- | --- | --- |
| Confidence stepping | one line per todo item: confidence at assignment → at completion; which spiked (+40 in one step); which the gate sent back | `function.call` args of `todowrite`, paired per item id; `todo.signal(confidence_spike)` |
| Hill-climbable goals | histogram, mean, median and % below 90 over the **first** rating each item gets (`ratings` carries the total, re-ratings included). Note this is the harsher axis: jcode publishes every submission, so compare on `ratings`, not the histogram | `todowrite` args; `todo.signal(hill_climb_low)` |
| Auto-poke | **sessions that ended with open todos** (from the LAST todowrite — measurable on logs from before the gate existed, which is the baseline), pokes fired, pokes followed by a tool call, items completed after a poke, skip reasons, and the ended-open rate split gate-on vs gate-off | `poke.*` events; `todowrite` args |

Numbers only reach the file: no item text, no session ids, no prompts.

First run on this machine (2026-09-12): 3,364 sessions, 213 with a todo list,
**111 of them (52%) ended with items still open**, zero pokes — every one
predates the gate. That is the number auto-poke exists to move.

---

## 3b. Run pathology — `pnpm bench:pathology`

Pass/fail cannot see a run that passes after forty minutes of reading. This
folds the same rollout logs into *how* each run spent its time. The unit is one
user prompt (a **run**), and idle time between prompts and time waiting on a
`question` answer are excluded. Free and offline. It writes nothing and is never
published, and it **does** print session ids so you can open the bad ones with
`freecode trace <id>`.

```bash
pnpm bench:pathology                  # summary + the 15 worst runs
pnpm bench:pathology --top 40 --since 7
pnpm bench:pathology --session <id>   # every run of one session
pnpm bench:pathology --rollout-dir D  # searched recursively, e.g. bench/agent-bench/results/<run>
pnpm bench:pathology --json           # every run, every field
```

| Column / flag | Meaning |
| --- | --- |
| `1st-edit` | time from the prompt to the first `edit`/`write` (or a bash command that writes — a heuristic, `bashWrites` in `--json`) |
| `dry(calls)` | longest stretch with no progress, minutes and tool calls |
| `reads/re` | reads, and rereads of the same path+range with no edit to it in between (`rereadsAfterCompact`: the first read was before a compaction) |
| `cmp/loop` | compactions, and those with no progress since the previous one |
| `long_dry` | dry ≥ 15 min **and** ≥ 30 calls |
| `reread_heavy` | ≥ 30% of ≥ 10 reads were rereads |
| `compact_loop` | any compaction with no progress since the last |
| `search_circles` | ≥ 5 byte-identical grep/glob calls with no progress between |
| `repeat_commands` | ≥ 5 byte-identical non-writing bash commands with no progress between |
| `stuck_error` | the same set of error lines (TS errors, `not ok`, FAIL, `XError: msg`) in bash output ≥ 4 times, counted across edits |
| `hung_call` | one model request waited ≥ 5 min for its first token — the provider or fetch layer, not the model getting lost |

Summary numbers are over runs with ≥ 10 tool calls; shorter runs are chat.
A zero-edit run is not by itself a failure (the user may have asked a
question), so treat flags as a list of things to look at, not a score.
Thresholds are `THRESHOLDS` in `bench/harness-signals/pathology.ts`.

First run (2026-10-12, 12,370 runs, 758 substantive): first edit p50 0.4 min /
p90 2.3 min, dry stretch p90 3.1 min, reread share 8%. **37 runs are
`reread_heavy`**, all zero-edit read-only runs of 3–8 min; the worst read one
file in full 18 times in 7 minutes. All 18 `compact_loop` hits are the
`compaction-boundary` eval case (tiny thresholds by design), where the measured
input shrink per compaction is ~5% and sometimes negative. No `long_dry` in the
host logs, because **isolated agent-bench trials discard their rollout logs**
along with their throwaway HOME (see TODO.md), so the long trials are not in
this data yet. Fixed the same day (`keepRollout`): an isolated trial's HOME is
now a per-trial host dir and `<trial>/rollout/` is kept, so
`pnpm bench:pathology --rollout-dir bench/agent-bench/results/<run>` works.

Two more flags came out of the first long-task run: `stuck_error` (the same set
of error lines in bash output ≥ 4 times, counted across edits, because a run
that keeps editing and keeps getting the same tsc error is not dry, it is stuck)
and `repeat_commands` (a non-writing bash command repeated with no progress).

---

## 4. Free, no model — unit tests

```bash
pnpm test:jcode-bench        # typechecks the harness (incl. the agent-bench code it imports), then curve/publish tests
pnpm test:harness-signals    # typechecks, then the fold tests (signals + pathology)
cd apps/core && pnpm test    # signals/*.test.ts: settings, diff, poke decisions, and a real-loop poke test
```

---

## 5. When to run what

| Trigger | Command | Cost |
| --- | --- | --- |
| Changed a gate, the fold, or the todo tool | the tests above | free |
| Want the page's signal sections current | `pnpm bench:signals` | free |
| A run felt slow or lost | `pnpm bench:pathology`, then `freecode trace <id>` | free |
| Is the optimisation harness still working? | `pnpm bench:jcode --tasks utf16-transcode --agents freecode --trials 1 --no-full-gate` | 1 climb |
| A comparable number | `pnpm bench:jcode --agents freecode,claude-code --trials 3` | 3 × 3 × 2 climbs (hours) |
| Show the effect of a gate on the climb | same, once plain and once with `FREECODE_AUTO_POKE=1` — the page labels the gated run | double |
| Decide a gate's default | `eval ab` per EVAL.md, then edit `DEFAULT_SIGNAL_SETTINGS` | paid |

**Never in CI.** Same reasoning as agent-bench.

---

## 6. Layout

```
apps/core/src/agent/signals/   settings.ts · todo-signals.ts · auto-poke.ts · tests (incl. loop-poke.test.ts)
apps/core/src/tools/todo.ts    confidence / hillClimbability on TodoItem
apps/core/src/rollout/types.ts poke.triggered · poke.skipped · todo.signal

bench/jcode-bench/
  agents/*.json                adapters (agent-bench shape; no turn cap)
  runner/                      run · tasks (stage upstream) · prompt · curve · grade · publish · publish-cli
  .cache/upstream/             the task repo (git-ignored)
  results/<run>/               per-trial artifacts (git-ignored)

bench/harness-signals/
  fold.ts · run.ts             the fold, and the scanner that publishes it

apps/web/app/bench/page.tsx    the hub (build-time reads of app/data/*)
apps/web/app/data/jcode-bench/<task>.json
apps/web/app/data/harness/signals.json
```
