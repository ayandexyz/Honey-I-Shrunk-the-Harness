# Finish-Time Verification: tests before "done", and code nobody calls

> **Status:** Draft (2026-10-13), approved in conversation section by section.
> Nothing built. **Branch:** `fix/stuck-error-recovery`.
> **Evidence:** `docs/2026-10-13-long-task-bench-results.md` §3.3, the nine
> `pathology-commits-v2` trials, `TODO.md` ("Finishing without a full test run",
> "Built but never wired").
> **Related:** `agent/verify.ts` (verify gate), `agent/subagent.ts`
> (`verifyChanges`, the adversarial verifier), `2026-10-13-stuck-loop-recovery.md`
> (its Phase 4 rerun is shared with this spec's).

---

## 0. What we are trying to do (plain language)

When freecode finishes a bigger change, two things go wrong:

1. **It says "done" without running the tests**, so it ships breakage in files
   it did not touch. Two of nine long trials did exactly that.
2. **It builds a feature in pieces that are never connected.** Each piece exists
   and passes its own unit test, but nothing in the running program calls it
   (a new method only tests use; a flag the code writes and nothing reads).

freecode already has two finish-time checks. Neither catches these: the verify
gate only runs the **typecheck**, and the adversarial verifier is **read-only**,
so it cannot run tests, and it is only asked "do the changed files look right",
never "can a user actually reach this code".

This spec makes finishing a bigger change mean: **the affected package's tests
ran, new code has a caller, and the verifier checked reachability.** It adds
nudges, never hard blocks.

---

## 1. Evidence

All nine v2 long-task trials (6–14 changed files each):

| Check | What it did | Result |
|---|---|---|
| Verify gate | ran `pnpm run typecheck` (it picks `typecheck` first; `test` is never chosen) | never ran a test |
| Verifier | 12–26 read-only calls (read/grep), no bash | never ran a test, **never returned FAIL** (no trial reached `Verifier 2/2`) |

What got through:

- `add-agent-control` t2, t3: **regressions in untouched files** (`eval/dataset.test.ts`,
  `ipc/validate-params.test.ts`); the agent ran only the test files it edited.
- `add-agent-control` t1: `attachLoop` added to the registry, called only from
  `registry.test.ts`.
- Other trials: `cancelRequested` written, never read; `--push` calls a callback
  nobody supplies; `--worktree` makes a worktree and keeps working in the
  original checkout.

This repo's root `package.json` has **no `test` script** — tests run per
package (`pnpm -C apps/core test`) — so "run the root test script" would
silently run nothing here.

---

## 2. Design

At finish, a run that changed files goes through, in order:

1. **Typecheck** — unchanged.
2. **Tests** (new) — only when **≥3 files changed**, counted the way the
   verifier already counts them (`mutatedFiles`: files changed by `edit`/`write`
   this run; `VERIFIER_MIN_FILES`). Small edits stay fast.
3. **"No callers" check** (new) — deterministic, no model call.
4. **Adversarial verifier** — existing, read-only, gets more to work with.

Nothing ever hard-blocks; every new step is "fix it, or say why not".

### 2.1 Test run

- **Command:** `verify.testCommand` (settings) or `FREECODE_VERIFY_TEST_COMMAND`
  if set. Otherwise, for each changed file, the nearest `package.json` with a
  `test` script, run in that directory with the project's package manager
  (`pnpm -C <dir> test`, `npm --prefix <dir> test`, `yarn --cwd <dir> test`),
  deduplicated. None found →
  skipped with a log line.
- **Own attempt cap:** 2, separate from the typecheck's.
- **On failure:** a reminder with the failing test names (`not ok` / `✖` lines,
  via `errorLines` from `agent/repeated-error.ts`) plus a short tail, and one
  more turn — exactly how the typecheck failure works today.
- **Failures that were already failing:** the gate cannot know them without a
  second full run at start. The reminder says *"if a failure was already
  failing before your change, say so and stop"*; the 2-attempt cap means it
  cannot loop.
- **Off:** `verify.tests: false` / `FREECODE_VERIFY_TESTS=0`.

### 2.2 "No callers" check

- **New this run:** before the first `edit`/`write` to a file in a run, the
  loop keeps its content. At finish it compares declarations in that copy with
  the current file. (A `git diff` would also blame the user's own uncommitted
  work.)
- **Declarations:** JS/TS only (`.ts .tsx .js .mjs .cjs .mts`) — `function x(`,
  `const x = (…) =>`, `class X`, and class methods `x(…) {`. Types and
  interfaces are skipped (they never run). Other languages: not yet.
- **References:** `git grep -w <name>` across the repo, ignoring the
  definition line and test files (`*.test.*`, `*.spec.*`, `__tests__/`). A
  mention inside a string counts, so string-keyed dispatch is not flagged.
- **Result:** any names left → **one reminder per run** listing up to 20 as
  `file:line`: *"Nothing outside tests calls these. Wire them into the code path
  that uses them, or say why they are intentionally unused."*
- **Skipped** outside a git repo. **Off:** `FREECODE_UNWIRED_CHECK=0`.

### 2.3 Verifier

Its task prompt gains:

- the test result from 2.1 (passed / the failing names / skipped);
- the "no callers" list from 2.2;
- an instruction: *"For each new function, flag, option or field, trace it from
  a user entry point (CLI command, tool, IPC handler, config read) to where it
  takes effect. Something written and never read, or built and never called
  from a real path, is FAIL."*

It stays read-only; verdicts and the FAIL → fix loop are unchanged.

### 2.4 Logging

Counts only, never names or paths (OTLP stays leak-free):

- `verify.ran { kind: "typecheck" | "tests", ok, ms, failing }`
- `unwired.flagged { count }`

So `bench:pathology` can fold "did a full test run happen before finishing"
from the log.

---

## 3. What this will and will not catch

| v2 case | Caught by |
|---|---|
| t2/t3 regressions in untouched files | **2.1** — the `apps/core` suite fails |
| t1 `attachLoop` called only from tests | **2.2** |
| `cancelRequested` written, never read; `--push` callback never supplied; `--worktree` in the wrong checkout | **only 2.3**, if the model traces — **not guaranteed** |

Out of scope: answering repo questions without reading (#10, needs its own
investigation first), non-JS languages in 2.2, any hard block.

---

## 4. Phases

| Phase | Content | Pass bar |
|---|---|---|
| 1 | **Offline calibration (free).** Run 2.2 on the nine v2 patches (on their parent commits) and on this repo's last ~50 real `apps/core` commits. Measure, from rollout history, how often a ≥3-file run ran a full test command after its last edit. | Flags `attachLoop` in t1; **≤1 false flag per real commit on average**, else tighten 2.2 first. |
| 2 | **2.1 + 2.2** in the loop, unit tests, logging, off switches. New coding eval case: a multi-file feature whose checker goes only through the entry point. | `eval ab coding`, new case included, no regression. |
| 3 | **2.3** verifier prompt. | `eval ab` on the new case (the verifier only runs on ≥3-file changes, so short evals show little). |
| 4 | **Release + long-task rerun** (shared with the stuck-loop spec): same nine trials, Haiku judge with the parent-commit baseline. | No regressions beyond the baseline; fewer "never wired" weaknesses; judge mean up. Report the minutes 2.1 adds per long run (expect ~2–3). |
