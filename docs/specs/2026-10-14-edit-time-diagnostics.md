# Edit-Time Diagnostics, and a Verify Gate You Can See

> **Status:** Phases 1–3 **built 2026-10-14** (`agent/loop.ts` `runGateCommand`,
> `tools/lsp/feedback.ts`, `tools/lsp/client.ts`). Phase 3's `eval ab` held
> (coding.jsonl: 45/45 → 44/45, cost flat-to-lower — `evals/experiments.jsonl`
> `2026-10-14-coding-1`, kept), so `FREECODE_EDIT_DIAGNOSTICS` is **on by
> default**; `0` opts out. A bug found while running that eval — `disposeAll()`
> in `tools/lsp/client.ts` was never called, so every sandboxed trial's
> language server leaked for the run's life and the harness never exited on
> its own — is fixed (`eval/sandbox.ts` `disposeRoot`, `eval/runner.ts`
> `shutdownRunner`, `server.ts` shutdown). Phase 4 (drop `build` from
> `SCRIPT_PRIORITY`) not run.
> **Branch:** `fix/agent-fold-activity`.
> **Evidence:** session `5ea1fdcb-01bb-4026-b3bd-a574b4fc6232`
> (`~/.freecode/rollout/sessions/5ea1fdcb…/events.jsonl`).
> **Related:** `agent/verify.ts` (the verify gate),
> `2026-10-13-finish-time-verification.md`, `tools/lsp/` (the LSP client the
> `lsp` tool already uses).
> **Prior art:** Claude Code `services/diagnosticTracking.ts`,
> `services/lsp/LSPDiagnosticRegistry.ts`, `tools/FileEditTool/FileEditTool.ts`;
> OpenCode `packages/opencode/src/tool/write.ts`, `src/lsp/client.ts`,
> `src/lsp/server.ts`.

---

## 0. The problem (plain language)

The user watched the "in progress" line sit for **minutes** after the model had
already finished, and only then got the "elapsed" line. The session log shows why:

| t | event |
|---|---|
| 0:00 | turn starts; model runs `pnpm run build` (66 s) |
| 1:20 | model edits one file, runs `pnpm run build` again (91 s) — passes |
| **2:55** | model's last reply: text, no tool calls. **Done.** |
| 2:55 → **4:27** | `verify.ran kind:"typecheck" ms:92949` — the verify gate |
| 4:27 | run returns; TUI swaps "in progress" for "elapsed" |

The project (`admin`, Next.js) has no `typecheck` script, so
`resolveVerifyCommand` fell back to `build` and ran a **third** `next build`,
93 s, four seconds after the model's identical build had passed. Three faults:

1. **Silent.** The gate only `console.log`s; no `notice` reaches the frontend.
2. **Mislabelled.** The rollout records `kind: "typecheck"` whatever ran.
3. **Wrong tool for the job.** The gate exists to catch "declared done on
   uncompiled code". A full production build is the slowest possible way to
   learn that, it runs once at the very end (so a type error costs a whole
   extra turn), and at 120 s `VERIFY_TIMEOUT_MS` a slightly slower machine
   turns a green build into a forced "fix it" turn.

The fast way to learn "this edit broke the types" is the language server, at
edit time. freecode already ships an LSP client (`tools/lsp/client.ts`) for the
`lsp` tool, but nothing feeds its diagnostics back after an edit — and it never
sends `didChange`, so after any edit its diagnostics are stale anyway.

## 1. What we build

### 1.1 Gate visibility (fixes faults 1–2; no behaviour change)

- A `notice` (level `info`) when the gate starts — `Verifying: pnpm run build` —
  and one when it ends — `build passed (93s)` / `build failed (93s)`. Same for
  the test gate. The TUI already renders `notice`.
- `verify.ran` gains `script` (the resolved label, e.g. `build`). `kind` keeps
  its two values so existing folds are untouched.

Not done: skipping the gate when the model just ran the same command. In this
very session the model ran `pnpm run build 2>&1 | tail -100` — the pipeline's
exit code is `tail`'s, so "it passed" cannot be read from the tool result.

### 1.2 Edit-time diagnostics (fixes fault 3, behind a flag)

**Delivery — Claude Code's way.** The edit returns immediately; diagnostics
are folded into the **next** model request as a `<system-reminder>` via
`pendingReminders` (so after the cache anchors — RC8 holds, and the edit tool's
own output bytes do not change).

1. `read` / `edit` / `write` of a file with a configured server opens it on the
   server (`didOpen`); `edit` / `write` then send `didChange` (full text,
   version + 1) and `didSave`. Opening on `read` is what gives a **baseline**:
   by the time the model edits, the server has usually published the file's
   pre-existing errors.
2. Every `publishDiagnostics` is stored per URI with a monotonically increasing
   sequence number; a `didChange` clears the URI's entry so a stale pre-edit
   push is never mistaken for the result.
3. Before each model request the loop drains the session:
   - per URI with a push newer than the session last saw, compute the
     **errors only** (severity 1), keyed `line:col:message`;
   - the **first** push for a URI the session has not edited yet is the
     baseline — recorded, not reported;
   - otherwise report errors in excess of the baseline, keyed by **message**
     (not position: an edit above an old error moves it), skipping messages
     already reported for that URI. Editing the file again clears its
     "reported" set, so an error still there after the next edit is said
     again; without an edit nothing repeats, and pre-existing errors never
     show. A file edited before its first push has no baseline — everything
     in it is reported;
   - if an edited URI has had no push since its `didChange`, wait for it —
     bounded at **1.5 s** for the whole drain. Without this the next request
     usually leaves before the server answers (the loop calls the model
     milliseconds after the tool returns).
   - cap at 10 errors per file, 30 total, with "… and N more".
4. Rendered as
   `<new-diagnostics>Your edits introduced these errors:\n<file>\n  ERROR L:C message …</new-diagnostics>`.

Other open files the server re-checks (an importer the model read earlier) are
covered by the same rule, which is the cross-file value of doing this at all.

**Server discovery — OpenCode's way** (Claude Code requires a plugin; this
machine has no `typescript-language-server`, so plugins-only would mean nothing
happens). For each registry command, first hit wins:

1. `<project>/node_modules/.bin/<command>`
2. `PATH`
3. `~/.freecode/lsp/node_modules/.bin/<command>`, installed **once, in the
   background** with `npm install --prefix ~/.freecode/lsp <package>` for the
   npm-installable servers (`typescript-language-server` + `typescript`,
   `pyright`). The edit that triggered the install gets no diagnostics; later
   ones do. `FREECODE_LSP_AUTO_INSTALL=0` turns the install off.

**Flag.** `FREECODE_EDIT_DIAGNOSTICS=0` turns it off. **On by default since
Phase 3** — it changes what the model sees, so flipping the default was an
`eval ab` decision (CLAUDE.md), and `eval/experiments.jsonl`'s
`2026-10-14-coding-1` is that decision's record. Subagents follow the same
flag.

**Rollout.** `diagnostics.delivered` with counts only (files, errors,
waitedMs) — never messages or paths, so OTLP stays leak-free.

## 2. Phases

| Phase | What | Done when |
|---|---|---|
| 1 | §1.1 gate notices + `script` field | unit test; manual run shows the notice |
| 2 | §1.2 client `didChange`/`didSave`, seq store, drain + baseline, discovery + auto-install, flag | `feedback.test.ts` against a fake server (stale push then fresh, baseline silent, once-only, 1.5 s cap) |
| 3 | `eval ab` with `FREECODE_EDIT_DIAGNOSTICS` 0/1 on `coding.jsonl` | **done 2026-10-14**: 15 cases × 3 trials, 45/45 → 44/45, cost $0.4823 → $0.4521; the one dip (`fix-in-nested-dir`) re-ran at 8 trials/side (6/8 → 7/8, same failure both sides) and is a pre-existing model flake, not a regression — default flipped on |
| 4 | With Phase 3 on: drop `build` from `SCRIPT_PRIORITY` (typecheck-style scripts only) | `eval ab` again — this is a gate behaviour change |

## 3. Not doing

- **Blocking the edit to wait for diagnostics** (OpenCode's 5 s in-tool wait):
  costs every edit; the bounded drain wait costs only edits that have a server.
- **Skipping the gate when the model already ran it** — see §1.1.
- **Warnings / hints** — errors only, as both prior-art tools do by default.
- **Servers beyond the existing registry** (`ts/js`, `py`, `rs`, `go`), and
  auto-install for non-npm ones (`rust-analyzer`, `gopls`).
