# Finish-Time Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before freecode finishes a change of ≥3 files, run the affected packages' tests, name new code that nothing outside tests calls, and have the verifier check that new code is reachable.

**Architecture:** Two new pure modules in `apps/core/src/agent/` — `unwired.ts` (new declarations with no non-test callers, via `git grep`) and `verify-tests.ts` (which test commands to run, settings, failure reminder) — wired into the loop's existing finish gates in `agent/loop.ts`, between the typecheck gate and the adversarial verifier. Two new rollout events record what ran (counts only). The verifier's prompt gains the test result, the unwired list and a reachability instruction. Nothing hard-blocks.

**Tech Stack:** TypeScript (Node ≥22, ESM), `node:test` + `tsx --test`, `git grep`, pnpm monorepo.

**Spec:** `docs/specs/2026-10-13-finish-time-verification.md` (approved). Read it first.

## Global Constraints

- Tests run only when `mutatedFiles.size >= VERIFIER_MIN_FILES` (3, `agent/subagent.ts`).
- Test command: `verify.testCommand` setting / `FREECODE_VERIFY_TEST_COMMAND`, else the nearest `package.json` with a `test` script per changed file, run in that directory (`pnpm -C <dir> test`, `npm --prefix <dir> test`, `yarn --cwd <dir> test`, `bun --cwd <dir> run test`), deduplicated. None found → skipped.
- Test gate: its own cap of **2** attempts (separate from `MAX_VERIFY_ATTEMPTS`), timeout **600 s** per command.
- Off switches: `verify.tests: false` / `FREECODE_VERIFY_TESTS=0`; `FREECODE_UNWIRED_CHECK=0`. Both read per call (so `eval ab` can flip them).
- Unwired check: JS/TS only (`.ts .tsx .js .mjs .cjs .mts`); test paths are `*.test.*`, `*.spec.*`, `__tests__/`; skipped outside a git repo; **one reminder per run**, at most **20** names.
- Logging: `verify.ran { kind, ok, ms, failing }`, `unwired.flagged { count }` — **never names or paths**.
- Nudges only: no new hard block anywhere.
- Code style: match surrounding files (header comment block, explain *why*), `.js` import suffixes, files ≲150 lines (`loop.ts` excepted).
- Every behaviour change ships with its test next to the code; `pnpm -C apps/core test` and `npx tsc --noEmit -p apps/core` green before each commit.
- **Never run evals in parallel** (MiniMax Token Plan rate limit, see `EVAL.md`).

## Review Focus

1. **Pre-existing test failures** (e.g. a repo whose suite was already red): the gate must not loop — 2 attempts, then the run finishes with the failure reported. Test in Task 5.
2. **Calls that look like declarations** (`setTimeout(() => {` added once): must not be reported as an unwired method. Test in Task 1.
3. **Monorepo without a root `test` script** (this repo): changes in `apps/core` must run `apps/core`'s tests, never silently nothing. Test in Task 3.
4. **Relative vs absolute paths in `mutatedFiles`** (`edit` gets either): both must resolve to the same package and the same before-snapshot. Tests in Tasks 3 and 5.
5. **npm's placeholder `test` script** (`echo "Error: no test specified" && exit 1`): must be treated as "no test script", not as a failing suite. Test in Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/core/src/agent/unwired.ts` (new) | Find declarations added between two versions of a JS/TS file; find which have no references outside tests; the reminder text; `checkUnwired()` for the loop. |
| `apps/core/src/agent/unwired.test.ts` (new) | Unit tests, including a real `git init` fixture. |
| `apps/core/src/agent/verify-tests.ts` (new) | `verify.*` settings; which test commands to run for a set of changed files; failing-line extraction; the test-failure reminder. |
| `apps/core/src/agent/verify-tests.test.ts` (new) | Unit tests with temp monorepo fixtures. |
| `apps/core/src/agent/verify.ts` (modify) | `runVerify` gains a timeout parameter and returns the unclipped `raw` output; `detectPackageManager` exported. |
| `apps/core/src/rollout/{types,recorder}.ts` (modify) | `verify.ran`, `unwired.flagged`. |
| `apps/core/src/agent/loop.ts` (modify) | Before-edit snapshots; test gate; unwired gate; pass results to the verifier. |
| `apps/core/src/agent/finish-gates-loop.test.ts` (new) | Real loop + fake model: test gate fails then passes; unwired reminder fires once. |
| `apps/core/src/agent/subagent.ts` (modify) | `buildVerifierTask()` (extracted) gains test result, unwired list, reachability instruction. |
| `apps/core/src/settings/known-keys.ts`, `schemas/settings.schema.json` (modify) | Register `verify.tests`, `verify.testCommand`. |
| `apps/core/src/eval/ab.ts` (modify) | Allowlist `FREECODE_VERIFY_TESTS`, `FREECODE_UNWIRED_CHECK`. |
| `bench/harness-signals/unwired-calibrate.ts` (new) + `package.json` script `bench:unwired` | Phase 1 offline calibration. |
| `evals/coding.jsonl` (append) | `wire-a-new-flag-through-the-cli` case. |
| Docs | `ENV.md`, `CLAUDE.md`, `TODO.md`, the spec's status and §4 results. |

---

### Task 1: Unwired-declaration finder (`agent/unwired.ts`)

**Files:**
- Create: `apps/core/src/agent/unwired.ts`
- Test: `apps/core/src/agent/unwired.test.ts`

**Interfaces:**
- Produces:
  - `interface Declaration { name: string; file: string; line: number }` — `file` relative to the project root, `line` 1-based.
  - `isJsFile(file: string): boolean`, `isTestPath(file: string): boolean`
  - `declarationsIn(source: string, file: string): Declaration[]`
  - `newDeclarations(before: string, after: string, file: string): Declaration[]`
  - `type Grep = (name: string) => string[]` — lines `path:line:text`, paths relative to the project root.
  - `findUncalled(decls: Declaration[], grep: Grep): Declaration[]`
  - `gitGrep(projectRoot: string): Grep | undefined` — `undefined` outside a git repo.
  - `checkUnwired(projectRoot: string, before: Map<string, string | null>): Declaration[]` — keys are absolute paths; value `null` = the file did not exist. Returns at most `UNWIRED_MAX` (20).
  - `unwiredReminder(items: Declaration[]): string`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/core/src/agent/unwired.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkUnwired,
  declarationsIn,
  findUncalled,
  isTestPath,
  newDeclarations,
  unwiredReminder,
} from "./unwired.js";

test("declarationsIn finds functions, arrow consts, classes and methods — not calls or types", () => {
  const src = [
    "export function alpha(x) {",
    "export const beta = async (y) => y;",
    "export class Gamma {",
    "  attachLoop(id: string, loop: { steer: (t: string) => void }): void {",
    "  private async delta() {",
    "  if (ready) {",
    "  setTimeout(() => {",
    "  items.forEach((x) => {",
    "export interface Epsilon { a: number }",
    "export type Zeta = string;",
  ].join("\n");
  assert.deepEqual(
    declarationsIn(src, "a.ts").map((d) => `${d.name}:${d.line}`),
    ["alpha:1", "beta:2", "Gamma:3", "attachLoop:4", "delta:5"],
  );
});

test("newDeclarations is what the edit added, by name", () => {
  const before = "export function kept() {\n";
  const after = "export function kept() {\nexport function added() {\n";
  assert.deepEqual(newDeclarations(before, after, "m.ts"), [{ name: "added", file: "m.ts", line: 2 }]);
  assert.deepEqual(newDeclarations("", "", "m.ts"), []);
});

test("isTestPath", () => {
  for (const p of ["a.test.ts", "src/x.spec.mjs", "pkg/__tests__/y.ts"]) assert.equal(isTestPath(p), true, p);
  for (const p of ["src/testing.ts", "src/latest.ts"]) assert.equal(isTestPath(p), false, p);
});

test("findUncalled ignores the definition line and test files", () => {
  const decl = { name: "attachLoop", file: "src/registry.ts", line: 40 };
  const onlyTests = () => ["src/registry.ts:40:  attachLoop(id) {", "src/registry.test.ts:12:  reg.attachLoop(\"a1\")"];
  assert.deepEqual(findUncalled([decl], onlyTests), [decl]);
  const called = () => [...onlyTests(), "src/tools/agent.ts:88:    registry.attachLoop(id, loop);"];
  assert.deepEqual(findUncalled([decl], called), []);
});

test("checkUnwired on a real git repo: a new method only tests call is reported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-unwired-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });
  try {
    git("init", "-q");
    const reg = path.join(dir, "registry.ts");
    const before = "export class Registry {\n  register(id: string) {\n  }\n}\n";
    fs.writeFileSync(reg, before);
    fs.writeFileSync(path.join(dir, "main.ts"), "new Registry().register('a');\n");
    git("add", "-A");
    // The run adds attachLoop; only a test calls it. setTimeout is a call, not a declaration.
    fs.writeFileSync(reg, "export class Registry {\n  register(id: string) {\n  }\n  attachLoop(id: string) {\n    setTimeout(() => {\n    });\n  }\n}\n");
    fs.writeFileSync(path.join(dir, "registry.test.ts"), "new Registry().attachLoop('a');\n");
    git("add", "-A");
    const found = checkUnwired(dir, new Map([[reg, before]]));
    assert.deepEqual(found.map((d) => `${d.name}@${d.file}:${d.line}`), ["attachLoop@registry.ts:4"]);
    assert.match(unwiredReminder(found), /attachLoop \(registry\.ts:4\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkUnwired outside a git repo is skipped, not an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-unwired-nogit-"));
  try {
    const f = path.join(dir, "a.ts");
    fs.writeFileSync(f, "export function lonely() {\n}\n");
    assert.deepEqual(checkUnwired(dir, new Map([[f, null]])), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/core && npx tsx --test src/agent/unwired.test.ts`
Expected: FAIL — `Cannot find module './unwired.js'`.

- [ ] **Step 3: Implement**

```ts
// apps/core/src/agent/unwired.ts
// =============================================================================
// "No callers" check (spec 2026-10-13-finish-time-verification.md §2.2):
// declarations a run added that nothing outside tests references. The v2
// long-task trials built features whose parts each passed a unit test but were
// never connected — `attachLoop` added to the registry and called only from
// registry.test.ts. Deterministic and free: no model call.
//
// "New" is measured against the file as it was before the run's first edit
// (the loop keeps that copy), not `git diff`, which would also blame the
// user's own uncommitted work. References come from `git grep -w`; a mention
// inside a string counts, so string-keyed dispatch is not flagged.
// =============================================================================

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Declaration {
  name: string;
  /** Relative to the project root. */
  file: string;
  /** 1-based. */
  line: number;
}

export const UNWIRED_MAX = 20;

const JS_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const TEST_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\//;
// Line-start forms only. A method needs a trailing `{` on the same line, which
// is also how a call with a callback looks — hence CALL_LIKE below.
const FORMS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s+(?:(?:public|private|protected|static|override|async|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\(.*\)\s*(?::\s*[^={;]+)?\{\s*$/,
];
// Keywords and globals that open a block or take a callback: `if (x) {`,
// `setTimeout(() => {`. Not declarations.
const CALL_LIKE = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "constructor",
  "super", "else", "do", "try", "with", "typeof", "await", "new",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask",
  "describe", "it", "test", "before", "after", "beforeEach", "afterEach",
]);

export const isJsFile = (file: string): boolean => JS_FILE.test(file);
export const isTestPath = (file: string): boolean => TEST_PATH.test(file.split(path.sep).join("/"));

export function declarationsIn(source: string, file: string): Declaration[] {
  const out: Declaration[] = [];
  source.split("\n").forEach((text, i) => {
    for (const form of FORMS) {
      const name = text.match(form)?.[1];
      if (name && !CALL_LIKE.has(name)) {
        out.push({ name, file, line: i + 1 });
        break;
      }
    }
  });
  return out;
}

export function newDeclarations(before: string, after: string, file: string): Declaration[] {
  const had = new Set(declarationsIn(before, file).map((d) => d.name));
  return declarationsIn(after, file).filter((d) => !had.has(d.name));
}

/** `path:line:text` lines for a whole-word match, paths relative to the root. */
export type Grep = (name: string) => string[];

export function findUncalled(decls: Declaration[], grep: Grep): Declaration[] {
  return decls.filter((d) => {
    const refs = grep(d.name).filter((hit) => {
      const [file, line] = hit.split(":", 2);
      if (!file || isTestPath(file)) return false;
      return !(file === d.file && Number(line) === d.line);
    });
    return refs.length === 0;
  });
}

export function gitGrep(projectRoot: string): Grep | undefined {
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectRoot, encoding: "utf-8" });
  if (probe.status !== 0) return undefined;
  return (name) => {
    // -F: the name is literal; exit 1 means "no match", not an error.
    const r = spawnSync("git", ["grep", "-n", "-w", "-F", "--untracked", "-e", name], {
      cwd: projectRoot,
      encoding: "utf-8",
      maxBuffer: 16 << 20,
    });
    return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
  };
}

/**
 * What the loop calls at finish. `before` maps each file the run edited
 * (absolute path) to its content before the first edit, or null if the run
 * created it.
 */
export function checkUnwired(projectRoot: string, before: Map<string, string | null>): Declaration[] {
  const decls: Declaration[] = [];
  for (const [abs, old] of before) {
    const rel = path.relative(projectRoot, abs).split(path.sep).join("/");
    if (!isJsFile(rel) || isTestPath(rel) || !fs.existsSync(abs)) continue;
    decls.push(...newDeclarations(old ?? "", fs.readFileSync(abs, "utf-8"), rel));
  }
  if (decls.length === 0) return [];
  const grep = gitGrep(projectRoot);
  return grep ? findUncalled(decls, grep).slice(0, UNWIRED_MAX) : [];
}

export function unwiredReminder(items: Declaration[]): string {
  return [
    "<system-reminder>",
    "Nothing outside test files calls these, which you added in this run:",
    "",
    ...items.map((d) => `  - ${d.name} (${d.file}:${d.line})`),
    "",
    "Wire each one into the code path that is meant to use it (the CLI command,",
    "tool, IPC handler or caller that the user's request goes through), or say in",
    "one sentence why it is intentionally unused. Never mention this reminder to",
    "the user.",
    "</system-reminder>",
  ].join("\n");
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd apps/core && npx tsx --test src/agent/unwired.test.ts && npx tsc --noEmit -p .`
Expected: 6 pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/agent/unwired.ts apps/core/src/agent/unwired.test.ts
git commit -m "feat(agent): find new declarations nothing outside tests calls"
```

---

### Task 2: Phase 1 offline calibration (`bench:unwired`)

The spec's gate: **flag `attachLoop` in add-agent t1, and ≤1 false flag per real commit on average.** Run this before wiring anything into the loop. If it fails, stop and tighten `FORMS`/`CALL_LIKE` in Task 1 (with a test for each false positive) until it passes.

**Files:**
- Create: `bench/harness-signals/unwired-calibrate.ts`
- Modify: `package.json` (root) — script `"bench:unwired": "tsx bench/harness-signals/unwired-calibrate.ts"`

**Interfaces:**
- Consumes: `newDeclarations`, `findUncalled`, `isJsFile`, `isTestPath`, `type Grep` from Task 1.

- [ ] **Step 1: Write the calibration script**

```ts
// bench/harness-signals/unwired-calibrate.ts
// Phase 1 of spec 2026-10-13-finish-time-verification.md: replay the "no
// callers" check offline. (a) Real commits — each commit's own changes to
// non-test JS/TS files, refs grepped at that commit (`git grep <sha>`): a
// shipped commit is wired, so every hit is a false positive. (b) The nine v2
// long-task patches applied on their parent commit in a temp worktree.
//
//   pnpm bench:unwired [--commits 50] [--v2 <results dir>]
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findUncalled,
  isJsFile,
  isTestPath,
  newDeclarations,
  type Declaration,
  type Grep,
} from "../../apps/core/src/agent/unwired.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const git = (args: string[], cwd = ROOT) =>
  spawnSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 64 << 20 });
const show = (rev: string, file: string, cwd = ROOT) => {
  const r = git(["show", `${rev}:${file}`], cwd);
  return r.status === 0 ? r.stdout : "";
};
const grepAt = (rev: string | undefined, cwd: string): Grep => (name) => {
  const r = git(["grep", "-n", "-w", "-F", "-e", name, ...(rev ? [rev] : []), "--"], cwd);
  // `git grep <rev>` prefixes hits with "<rev>:"; strip it.
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean).map((l) => (rev ? l.slice(rev.length + 1) : l)) : [];
};

function scan(changed: string[], before: (f: string) => string, after: (f: string) => string, grep: Grep): Declaration[] {
  const decls = changed
    .filter((f) => isJsFile(f) && !isTestPath(f))
    .flatMap((f) => newDeclarations(before(f), after(f), f));
  return findUncalled(decls, grep);
}

// (a) real commits
const n = Number(arg("commits") ?? 50);
const shas = git(["log", `-${n}`, "--format=%H", "--no-merges", "--", "apps/core/src"]).stdout.split("\n").filter(Boolean);
let flags = 0;
for (const sha of shas) {
  const changed = git(["diff", "--name-only", `${sha}^`, sha, "--", "apps/core/src"]).stdout.split("\n").filter(Boolean);
  const hits = scan(changed, (f) => show(`${sha}^`, f), (f) => show(sha, f), grepAt(sha, ROOT));
  flags += hits.length;
  if (hits.length) console.log(`${sha.slice(0, 8)}  ${hits.map((h) => `${h.name}@${h.file}:${h.line}`).join(", ")}`);
}
console.log(`\nreal commits: ${shas.length}, flags ${flags}, ${(flags / Math.max(1, shas.length)).toFixed(2)} per commit (bar: ≤ 1.00)`);

// (b) v2 patches
const v2 = arg("v2");
if (v2) {
  const tasks = JSON.parse(fs.readFileSync(path.join(ROOT, "bench/agent-bench/instances/freecode-commits.json"), "utf-8")).evalCommits as { id: string; parentSha: string }[];
  for (const t of tasks) {
    for (const trial of fs.readdirSync(path.join(v2, `freecode__${t.id}`)).filter((d) => d.startsWith("trial-")).sort()) {
      const patch = path.join(v2, `freecode__${t.id}`, trial, "freecode", "patch.diff");
      if (!fs.existsSync(patch)) continue;
      const wt = fs.mkdtempSync(path.join(os.tmpdir(), "unwired-wt-"));
      try {
        execFileSync("git", ["worktree", "add", "-q", "--detach", wt, t.parentSha], { cwd: ROOT, stdio: "pipe" });
        if (git(["apply", "--whitespace=nowarn", patch], wt).status !== 0) {
          console.log(`${t.id} ${trial}: patch did not apply`);
          continue;
        }
        git(["add", "-A"], wt);
        const changed = git(["diff", "--cached", "--name-only"], wt).stdout.split("\n").filter(Boolean);
        const hits = scan(changed, (f) => show(t.parentSha, f, wt), (f) => (fs.existsSync(path.join(wt, f)) ? fs.readFileSync(path.join(wt, f), "utf-8") : ""), grepAt(undefined, wt));
        console.log(`${t.id} ${trial}: ${hits.map((h) => `${h.name}@${h.file}:${h.line}`).join(", ") || "(none)"}`);
      } finally {
        spawnSync("git", ["worktree", "remove", "--force", wt], { cwd: ROOT });
      }
    }
  }
}
```

- [ ] **Step 2: Run it**

Run: `pnpm bench:unwired --commits 50 --v2 /home/ayande/Downloads/long-task-results-2026-10-13/pathology-commits-v2`
Expected: the `add-agent-control trial-1` line contains `attachLoop@`; the real-commit line ends `≤ 1.00` with a value at or below 1.00.

- [ ] **Step 3: If the bar fails, tighten Task 1 and rerun**

For every false positive printed in (a), add a failing case to `declarationsIn`'s test in `unwired.test.ts`, change `FORMS`/`CALL_LIKE` in `unwired.ts` until it passes, rerun Step 2. Do not continue to Task 3 until the bar holds.

- [ ] **Step 4: Measure how often big runs already test before finishing**

Append to the same script and rerun:

```ts
// (c) rollout history: runs with ≥3 distinct edited files — did a test
// command run after the last edit? (The baseline Phase 4 compares against.)
const roll = path.join(os.homedir(), ".freecode", "rollout", "sessions");
let big = 0, tested = 0;
for (const s of fs.existsSync(roll) ? fs.readdirSync(roll) : []) {
  const f = path.join(roll, s, "events.jsonl");
  if (!fs.existsSync(f)) continue;
  const ev = fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const edited = new Set<string>();
  let lastEdit = -1, lastTest = -1;
  ev.forEach((e, i) => {
    if (e.type !== "function.call") return;
    const p = e.args?.filePath ?? e.args?.path;
    if (["edit", "write"].includes(e.tool) && typeof p === "string") { edited.add(p); lastEdit = i; }
    if (e.tool === "bash" && /\b(?:test|vitest|jest|--test)\b/.test(e.args?.command ?? "")) lastTest = i;
  });
  if (edited.size >= 3) { big++; if (lastTest > lastEdit) tested++; }
}
console.log(`\nrollout sessions with ≥3 edited files: ${big}; ran a test command after the last edit: ${tested} (${big ? Math.round((100 * tested) / big) : 0}%)`);
```

- [ ] **Step 5: Record the results in the spec and commit**

Add a `### 4.1 Phase 1 result (<date>)` section to `docs/specs/2026-10-13-finish-time-verification.md` with the three printed lines and any `FORMS`/`CALL_LIKE` changes made in Step 3; mark Phase 1 done in the §4 table.

```bash
git add bench/harness-signals/unwired-calibrate.ts package.json docs/specs/2026-10-13-finish-time-verification.md apps/core/src/agent/unwired.ts apps/core/src/agent/unwired.test.ts
git commit -m "feat(bench): calibrate the no-callers check offline (bench:unwired)"
```

---

### Task 3: Which tests to run (`agent/verify-tests.ts`) + `runVerify` changes + settings registration

**Files:**
- Create: `apps/core/src/agent/verify-tests.ts`, `apps/core/src/agent/verify-tests.test.ts`
- Modify: `apps/core/src/agent/verify.ts` (export `detectPackageManager`; `runVerify` timeout param + `raw`)
- Modify: `apps/core/src/settings/known-keys.ts`, `schemas/settings.schema.json`

**Interfaces:**
- Consumes: `VerifyCommand` (`{ command: string; label: string }`) and `detectPackageManager(projectPath): string` from `verify.ts`.
- Produces:
  - `interface VerifySettings { tests: boolean; testCommand?: string }`
  - `loadVerifySettings(projectRoot: string, env?: NodeJS.ProcessEnv): VerifySettings`
  - `resolveTestCommands(projectRoot: string, changedFiles: string[], settings: VerifySettings): VerifyCommand[]`
  - `failingTestLines(output: string): string[]`
  - `testFailureReminder(failures: { label: string; raw: string }[]): string`
  - `MAX_TEST_ATTEMPTS = 2`, `TEST_TIMEOUT_MS = 600_000`
  - `runVerify(command, projectPath, signal, timeoutMs?: number): Promise<{ ok: boolean; output: string; raw: string }>`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/core/src/agent/verify-tests.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  failingTestLines,
  loadVerifySettings,
  resolveTestCommands,
  testFailureReminder,
} from "./verify-tests.js";

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-verify-tests-"));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
}
const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });
const ON = { tests: true };

test("monorepo with no root test script: each changed file's own package runs its tests", () => {
  const dir = repo({
    "package.json": pkg({ typecheck: "tsc" }),
    "pnpm-lock.yaml": "",
    "apps/core/package.json": pkg({ test: "tsx --test" }),
    "apps/core/src/a.ts": "",
    "apps/core/src/b.ts": "",
    "apps/tui/package.json": pkg({ test: "tsx --test" }),
    "apps/tui/src/c.ts": "",
  });
  const cmds = resolveTestCommands(dir, ["apps/core/src/a.ts", path.join(dir, "apps/core/src/b.ts"), "apps/tui/src/c.ts"], ON);
  assert.deepEqual(cmds.map((c) => c.command), [
    `pnpm -C '${path.join(dir, "apps/core")}' test`,
    `pnpm -C '${path.join(dir, "apps/tui")}' test`,
  ]);
  assert.deepEqual(cmds.map((c) => c.label), ["tests (apps/core)", "tests (apps/tui)"]);
});

test("single-package npm repo uses --prefix at the root; npm's placeholder test script is no test script", () => {
  const real = repo({ "package.json": pkg({ test: "node --test" }), "src/a.js": "" });
  assert.deepEqual(resolveTestCommands(real, ["src/a.js"], ON).map((c) => c.command), [`npm --prefix '${real}' test`]);
  const placeholder = repo({ "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1' }), "src/a.js": "" });
  assert.deepEqual(resolveTestCommands(placeholder, ["src/a.js"], ON), []);
});

test("settings: testCommand overrides discovery; tests:false and the env switch turn it off", () => {
  const dir = repo({ ".freecode/settings.json": JSON.stringify({ verify: { testCommand: "make check" } }) });
  const s = loadVerifySettings(dir, {});
  assert.deepEqual(s, { tests: true, testCommand: "make check" });
  assert.deepEqual(resolveTestCommands(dir, ["x.ts"], s), [{ command: "make check", label: "tests" }]);
  assert.equal(loadVerifySettings(dir, { FREECODE_VERIFY_TESTS: "0" }).tests, false);
  assert.equal(loadVerifySettings(dir, { FREECODE_VERIFY_TEST_COMMAND: "just test" }).testCommand, "just test");
  const off = repo({ ".freecode/settings.json": JSON.stringify({ verify: { tests: false } }) });
  assert.equal(loadVerifySettings(off, {}).tests, false);
});

test("failing lines come from the whole output, not the clipped tail", () => {
  const raw = ["ok 1 - fine", "not ok 709 - every handler is declared", ...Array(5000).fill("noise"), "✖ providers.list (3ms)", "# fail 2"].join("\n");
  assert.deepEqual(failingTestLines(raw), ["not ok 709 - every handler is declared", "✖ providers.list (3ms)"]);
  const r = testFailureReminder([{ label: "tests (apps/core)", raw }]);
  assert.match(r, /tests \(apps\/core\) failed/);
  assert.match(r, /not ok 709 - every handler is declared/);
  assert.match(r, /already failing before your change, say so/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/core && npx tsx --test src/agent/verify-tests.test.ts`
Expected: FAIL — `Cannot find module './verify-tests.js'`.

- [ ] **Step 3: Change `verify.ts`**

Export the package-manager helper, give `runVerify` a timeout parameter, and return the unclipped output as `raw` (capped at 2 MB so a runaway suite cannot exhaust memory):

```ts
// verify.ts — replace `function detectPackageManager(` with:
export function detectPackageManager(projectPath: string): string {
```

```ts
// verify.ts — VerifyResult gains raw:
export interface VerifyResult {
  ok: boolean;
  /** Last MAX_OUTPUT_CHARS — what a reminder shows. */
  output: string;
  /** Everything (≤ RAW_OUTPUT_CHARS), for extracting failing test names. */
  raw: string;
}
const RAW_OUTPUT_CHARS = 2_000_000;
```

```ts
// verify.ts — replace the whole runVerify with:
export function runVerify(
  command: string,
  projectPath: string,
  signal: AbortSignal,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve({ ok: false, output: "(aborted)", raw: "" });

    const child = spawn("/bin/bash", ["-c", command], {
      cwd: projectPath,
      env: { ...process.env },
      stdio: "pipe",
    });

    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });

    // Keep the whole output (capped) — failing test names are printed where
    // each test ran, long before the tail a reminder shows.
    const add = (d: Buffer) => {
      out += d.toString();
      if (out.length > RAW_OUTPUT_CHARS) out = out.slice(-RAW_OUTPUT_CHARS);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);

    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const clipped =
        out.length > MAX_OUTPUT_CHARS
          ? "...(truncated)...\n" + out.slice(-MAX_OUTPUT_CHARS)
          : out || "(no output)";
      const suffix = timedOut ? "\n(verification timed out)" : "";
      resolve({ ok: code === 0 && !timedOut, output: clipped + suffix, raw: out + suffix });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ ok: false, output: `Failed to run verify command: ${err.message}`, raw: "" });
    });
  });
}
```

- [ ] **Step 4: Implement `verify-tests.ts`**

```ts
// apps/core/src/agent/verify-tests.ts
// =============================================================================
// Which tests to run before finishing (spec 2026-10-13-finish-time-
// verification.md §2.1). The verify gate only ran the typecheck, so two of
// nine long trials shipped regressions in files they never touched. For a
// change of ≥3 files the loop now runs the `test` script of the nearest
// package.json of each changed file — per package, because this repo (like
// many monorepos) has no root `test` script, and "run the root script" would
// silently run nothing.
// =============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envFlag } from "./signals/settings.js";
import { detectPackageManager, type VerifyCommand } from "./verify.js";

export const MAX_TEST_ATTEMPTS = 2;
/** This repo's core suite takes ~2–3 min; the typecheck's 120 s is too short. */
export const TEST_TIMEOUT_MS = 600_000;
const NPM_PLACEHOLDER = /no test specified/;
const FAILING_LINE = /^\s*not ok\b|^\s*✖ |\bFAIL\b|error TS\d+/;
const MAX_FAILING_LINES = 30;
const TAIL_CHARS = 2_000;

export interface VerifySettings {
  tests: boolean;
  testCommand?: string;
}

type Scope = { tests?: unknown; testCommand?: unknown };

function readScope(file: string): Scope | undefined {
  try {
    return (JSON.parse(fs.readFileSync(file, "utf-8")) as { verify?: Scope }).verify;
  } catch {
    return undefined;
  }
}

/** Project → user → default; env beats both. Read per call, for `eval ab`. */
export function loadVerifySettings(projectRoot: string, env: NodeJS.ProcessEnv = process.env): VerifySettings {
  const scopes = [path.join(projectRoot, ".freecode", "settings.json"), path.join(os.homedir(), ".freecode", "settings.json")]
    .map(readScope)
    .filter((s): s is Scope => s !== undefined);
  const tests = scopes.find((s) => typeof s.tests === "boolean")?.tests as boolean | undefined;
  const fileCmd = scopes.find((s) => typeof s.testCommand === "string" && s.testCommand.trim())?.testCommand as string | undefined;
  const envCmd = env.FREECODE_VERIFY_TEST_COMMAND?.trim();
  return {
    tests: envFlag(env.FREECODE_VERIFY_TESTS) ?? tests ?? true,
    ...((envCmd || fileCmd) ? { testCommand: envCmd || fileCmd } : {}),
  };
}

function hasTestScript(dir: string): boolean {
  try {
    const test = (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as { scripts?: Record<string, unknown> }).scripts?.test;
    return typeof test === "string" && !NPM_PLACEHOLDER.test(test);
  } catch {
    return false;
  }
}

const quote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

function inDir(pm: string, dir: string): string {
  if (pm === "pnpm") return `pnpm -C ${quote(dir)} test`;
  if (pm === "yarn") return `yarn --cwd ${quote(dir)} test`;
  if (pm === "bun") return `bun --cwd ${quote(dir)} run test`;
  return `npm --prefix ${quote(dir)} test`;
}

export function resolveTestCommands(projectRoot: string, changedFiles: string[], settings: VerifySettings): VerifyCommand[] {
  if (settings.testCommand) return [{ command: settings.testCommand, label: "tests" }];
  const root = path.resolve(projectRoot);
  const dirs: string[] = [];
  for (const f of changedFiles) {
    let dir = path.dirname(path.resolve(root, f));
    while (dir.startsWith(root)) {
      if (hasTestScript(dir)) {
        if (!dirs.includes(dir)) dirs.push(dir);
        break;
      }
      if (dir === root) break;
      dir = path.dirname(dir);
    }
  }
  const pm = detectPackageManager(root);
  return dirs.map((d) => ({ command: inDir(pm, d), label: `tests (${path.relative(root, d) || "."})` }));
}

export function failingTestLines(output: string): string[] {
  const seen = new Set<string>();
  for (const l of output.split("\n")) {
    if (FAILING_LINE.test(l)) seen.add(l.trim());
    if (seen.size >= MAX_FAILING_LINES) break;
  }
  return [...seen];
}

export function testFailureReminder(failures: { label: string; raw: string }[]): string {
  const body = failures.flatMap(({ label, raw }) => {
    const names = failingTestLines(raw);
    return [`${label} failed:`, ...(names.length ? names.map((n) => `  ${n}`) : ["  (no test names found; output tail below)"]), "", "```", raw.slice(-TAIL_CHARS), "```", ""];
  });
  return [
    "<system-reminder>",
    "You changed several files, so the tests of the packages you touched were run",
    "before finishing, and they failed. Fix the failures below, then continue. If a",
    "failure was already failing before your change, say so and stop — do not",
    "rewrite unrelated code to make it pass. Never mention this reminder to the user.",
    "",
    ...body,
    "</system-reminder>",
  ].join("\n");
}
```

- [ ] **Step 5: Register the settings**

In `apps/core/src/settings/known-keys.ts`, add to `KNOWN_SETTINGS` after `cache`:

```ts
  // `agent/verify-tests.ts` — the finish-time test run (≥3 changed files).
  verify: ["tests", "testCommand"],
```

In `schemas/settings.schema.json`, add under `properties`:

```json
"verify": {
  "description": "Finish-time verification: run the affected packages' tests before finishing a change of 3 or more files. See specs/2026-10-13-finish-time-verification.md.",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "tests": { "type": "boolean", "default": true, "description": "Run the tests at finish." },
    "testCommand": { "type": "string", "description": "Run this instead of discovering each changed file's package `test` script." }
  }
}
```

- [ ] **Step 6: Run to verify they pass**

Run: `cd apps/core && npx tsx --test src/agent/verify-tests.test.ts src/agent/verify.test.ts src/settings/known-keys.test.ts && npx tsc --noEmit -p .`
Expected: all pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add apps/core/src/agent/verify-tests.ts apps/core/src/agent/verify-tests.test.ts apps/core/src/agent/verify.ts apps/core/src/settings/known-keys.ts schemas/settings.schema.json
git commit -m "feat(agent): resolve per-package test commands for the finish gate"
```

---

### Task 4: Rollout events `verify.ran` and `unwired.flagged`

**Files:**
- Modify: `apps/core/src/rollout/types.ts`, `apps/core/src/rollout/recorder.ts`
- Test: `apps/core/src/rollout/recorder.test.ts`

**Interfaces:**
- Produces: `recorder.recordVerifyRan(kind: "typecheck" | "tests", ok: boolean, ms: number, failing: number): void`, `recorder.recordUnwiredFlagged(count: number): void`.

- [ ] **Step 1: Write the failing test** (append to `recorder.test.ts`)

```ts
test("verify.ran and unwired.flagged carry counts only", () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-rollout-"));
  try {
    const recorder = new RolloutRecorder("s1", { rolloutDir: dir });
    recorder.recordVerifyRan("tests", false, 1234, 2);
    recorder.recordUnwiredFlagged(3);
    const [ran, flagged] = readEvents(dir) as unknown as Record<string, unknown>[];
    assert.equal(ran.type, "verify.ran");
    assert.deepEqual([ran.kind, ran.ok, ran.ms, ran.failing], ["tests", false, 1234, 2]);
    assert.equal(flagged.type, "unwired.flagged");
    assert.equal(flagged.count, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/core && npx tsx --test src/rollout/recorder.test.ts`
Expected: FAIL — `recorder.recordVerifyRan is not a function`.

- [ ] **Step 3: Implement**

In `rollout/types.ts`, add `| VerifyRanEvent` and `| UnwiredFlaggedEvent` to the `RolloutEvent` union, and:

```ts
/** A finish-time check ran (spec 2026-10-13-finish-time-verification.md §2.4). Counts only. */
export interface VerifyRanEvent extends BaseEvent {
  type: "verify.ran";
  kind: "typecheck" | "tests";
  ok: boolean;
  ms: number;
  /** Failing test / error lines found in the output. */
  failing: number;
}

/** The "no callers" check named this many declarations. Never the names. */
export interface UnwiredFlaggedEvent extends BaseEvent {
  type: "unwired.flagged";
  count: number;
}
```

In `rollout/recorder.ts`, next to `recordLoopWarned`:

```ts
  recordVerifyRan(kind: "typecheck" | "tests", ok: boolean, ms: number, failing: number): void {
    this.write(this.makeEvent("verify.ran", { aggregateID: this.sessionId, fields: { kind, ok, ms, failing } }));
  }

  recordUnwiredFlagged(count: number): void {
    this.write(this.makeEvent("unwired.flagged", { aggregateID: this.sessionId, fields: { count } }));
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/core && npx tsx --test src/rollout/recorder.test.ts && npx tsc --noEmit -p .`
Expected: pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/rollout/types.ts apps/core/src/rollout/recorder.ts apps/core/src/rollout/recorder.test.ts
git commit -m "feat(rollout): record finish-time checks (verify.ran, unwired.flagged)"
```

---

### Task 5: Wire the test gate and the unwired gate into the loop

**Files:**
- Modify: `apps/core/src/agent/loop.ts`
- Modify: `apps/core/src/eval/ab.ts` (allowlist)
- Test: `apps/core/src/agent/finish-gates-loop.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 `checkUnwired`, `unwiredReminder`, `type Declaration`; Task 3 `loadVerifySettings`, `resolveTestCommands`, `failingTestLines`, `testFailureReminder`, `MAX_TEST_ATTEMPTS`, `TEST_TIMEOUT_MS`, `runVerify(…, timeoutMs)`; Task 4 recorder methods.
- Produces (for Task 6): loop fields `lastTestResult: string | undefined` and `lastUnwired: Declaration[]`, passed to `verifyChanges` as `testResult` and `unwired`.

- [ ] **Step 1: Write the failing end-to-end tests**

Model the harness on `apps/core/src/agent/repeated-error-loop.test.ts` (same layer setup, recorder pointed at a temp dir, fake provider registered with `registerProvider`). The fake answers the verifier subagent with `VERDICT: PASS`.

```ts
// apps/core/src/agent/finish-gates-loop.test.ts
// =============================================================================
// Finish-time verification end to end (spec 2026-10-13-finish-time-
// verification.md §2.1–2.2): the real loop, a scripted fake model.
// =============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestLayer } from "../effect/layers.js";
import { makeRuntime } from "../effect/runtime.js";
import { SessionStoreTag } from "../effect/context.js";
import { createAgentLoopEffect } from "./loop.js";
import { MemoryService } from "../compaction/service.js";
import { createRecorder } from "../rollout/recorder.js";
import { registerProvider } from "../providers/registry.js";
import type { ProviderId } from "../providers/config.js";
import type { AIProvider, ExecuteOptions, ProviderChunk } from "../providers/types.js";

type Step = { write?: [string, string]; say?: string };
let script: Step[] = [];
const tails: string[] = [];
const info = { id: "finish-fake", name: "finish-fake", defaultModel: "m", supportsStreaming: true, supportsTools: true };

registerProvider("finish-fake" as ProviderId, {
  info,
  create: (): AIProvider => ({
    info,
    execute: async () => { throw new Error("not used"); },
    stream: async function* (opts: ExecuteOptions): AsyncGenerator<ProviderChunk> {
      // The verifier subagent: always passes, so it never consumes the script.
      if (JSON.stringify(opts).includes("adversarially verify")) {
        yield { type: "text_delta", delta: "Looks fine.\nVERDICT: PASS" };
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      tails.push(opts.ephemeralTail ?? "");
      const step = script.shift() ?? { say: "done" };
      if (step.write) {
        yield { type: "tool_call", id: `c${tails.length}`, name: "write", args: { filePath: step.write[0], content: step.write[1] } };
      } else {
        yield { type: "text_delta", delta: step.say ?? "done" };
      }
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    },
  }),
});

async function run(projectPath: string, steps: Step[]) {
  script = steps;
  tails.length = 0;
  const sessionId = `finish-${Math.random().toString(36).slice(2)}`;
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-finish-rollout-"));
  const runtime = makeRuntime(
    makeTestLayer({
      memoryFactory: {
        forSession: () => new MemoryService(sessionId, { storage: { save: () => {}, load: () => undefined, listSessions: () => [], delete: () => {} } as never }),
      },
      recorderFactory: { forSession: (id: string) => createRecorder(id, { rolloutDir }) },
    }),
  );
  try {
    const store = await runtime.runPromise(SessionStoreTag);
    await store.createSession({ title: "t", projectPath, provider: "finish-fake" }, sessionId);
    const loop = await runtime.runPromise(createAgentLoopEffect(sessionId, { maxIterations: 20 }));
    await loop.run({ prompt: "change it", sessionId, provider: "finish-fake", projectPath, agentMode: "danger" });
    const f = join(rolloutDir, "events.jsonl");
    return existsSync(f) ? readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  } finally {
    await runtime.dispose();
    rmSync(rolloutDir, { recursive: true, force: true });
  }
}

test("a ≥3-file change runs the package's tests; a failure comes back once, the fix finishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-finish-tests-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node check.mjs" } }));
    writeFileSync(join(dir, "check.mjs"), `import { readFileSync } from "node:fs";\nif (readFileSync(new URL("./c.txt", import.meta.url), "utf-8") !== "fixed") { console.log("not ok 1 - c.txt is fixed"); process.exit(1); }\nconsole.log("ok 1");\n`);
    const events = await run(dir, [
      { write: [join(dir, "a.txt"), "a"] },
      { write: [join(dir, "b.txt"), "b"] },
      { write: [join(dir, "c.txt"), "broken"] },
      { say: "done" },
      { write: [join(dir, "c.txt"), "fixed"] },
      { say: "done" },
    ]);
    const told = tails.filter((t) => t.includes("the tests of the packages you touched were run"));
    assert.equal(told.length, 1, "one failure reminder");
    assert.match(told[0]!, /not ok 1 - c\.txt is fixed/);
    const ran = events.filter((e) => e.type === "verify.ran" && e.kind === "tests");
    assert.deepEqual(ran.map((e) => e.ok), [false, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a red suite that stays red ends after 2 attempts instead of looping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-finish-red-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('not ok 1 - always'); process.exit(1)\"" } }));
    const events = await run(dir, [
      { write: [join(dir, "a.txt"), "a"] },
      { write: [join(dir, "b.txt"), "b"] },
      { write: [join(dir, "c.txt"), "c"] },
      { say: "done" },
      { say: "That test was already failing before my change." },
      { say: "Already failing." },
    ]);
    assert.equal(events.filter((e) => e.type === "verify.ran" && e.kind === "tests").length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new function nobody calls gets one reminder naming it, and an answer ends it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-finish-unwired-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });
  try {
    git("init", "-q");
    writeFileSync(join(dir, "main.ts"), "console.log(1);\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    const events = await run(dir, [
      { write: [join(dir, "lib.ts"), "export function helper() {\n  return 1;\n}\n"] },
      { say: "done" },
      { say: "helper is intentionally unused for now." },
    ]);
    const told = tails.filter((t) => t.includes("Nothing outside test files calls these"));
    assert.equal(told.length, 1);
    assert.match(told[0]!, /helper \(lib\.ts:1\)/);
    assert.deepEqual(events.filter((e) => e.type === "unwired.flagged").map((e) => e.count), [1]);
    assert.ok(!JSON.stringify(events).includes("helper"), "names never enter the log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/core && npx tsx --test src/agent/finish-gates-loop.test.ts`
Expected: FAIL — no failure reminder (`told.length` 0).

- [ ] **Step 3: Loop state and imports**

In `agent/loop.ts`, add imports:

```ts
import { checkUnwired, unwiredReminder, type Declaration } from "./unwired.js";
import {
  failingTestLines,
  loadVerifySettings,
  MAX_TEST_ATTEMPTS,
  resolveTestCommands,
  testFailureReminder,
  TEST_TIMEOUT_MS,
} from "./verify-tests.js";
```

Next to `private mutatedFiles = new Set<string>();` add:

```ts
  // Finish-time verification (spec 2026-10-13-finish-time-verification.md).
  // Each edited file's content before the run's first edit to it (null: the
  // run created it), keyed by absolute path — what "new this run" means for
  // the no-callers check.
  private preEditContent = new Map<string, string | null>();
  private testAttempts = 0;
  private unwiredChecked = false;
  // Handed to the verifier: what the test gate saw, and what the no-callers
  // check named.
  private lastTestResult: string | undefined;
  private lastUnwired: Declaration[] = [];
```

In `run()`, next to `this.mutatedFiles = new Set<string>();`:

```ts
    this.preEditContent = new Map();
    this.testAttempts = 0;
    this.unwiredChecked = false;
    this.lastTestResult = undefined;
    this.lastUnwired = [];
```

- [ ] **Step 4: Keep the before-edit copy**

Add a method (next to `restoreRecentFiles`):

```ts
  // ===========================================================================
  // PRIVATE: capturePreEdit()
  // The first time a run edits or writes a file, keep what it was, so the
  // no-callers check can tell what THIS run added (agent/unwired.ts).
  // ===========================================================================
  private capturePreEdit(tc: ToolCall): void {
    if (!EDIT_TOOL_IDS.has(tc.tool)) return;
    const a = tc.args as { filePath?: unknown; path?: unknown } | undefined;
    const fp = a?.filePath ?? a?.path;
    if (typeof fp !== "string") return;
    const abs = path.resolve(this.state.projectPath, fp);
    if (this.preEditContent.has(abs)) return;
    let content: string | null = null;
    try {
      content = fs.readFileSync(abs, "utf-8");
    } catch {
      // Created by this run.
    }
    this.preEditContent.set(abs, content);
  }
```

`loop.ts` already has `import * as path from "path";` (line 14) but no `fs` import — add next to it:

```ts
import * as fs from "fs";
```

Call it just before each batch executes — replace the `batchResults` assignment:

```ts
        for (const tc of batch) this.capturePreEdit(tc);
        const batchResults = parallel
          ? await Promise.all(batch.map((tc) => this.executeTool(tc)))
          : [await this.executeTool(batch[0])];
```

- [ ] **Step 5: Record the typecheck run**

In the existing typecheck gate, wrap the `runVerify` call:

```ts
              const startedAt = Date.now();
              const verify = await runVerify(verifyCmd.command, this.state.projectPath, this.abort.signal);
              this.recorder.recordVerifyRan("typecheck", verify.ok, Date.now() - startedAt, failingTestLines(verify.raw).length);
```

- [ ] **Step 6: The test gate and the unwired gate**

Insert between the end of the typecheck gate block and the `// Adversarial verification gate` comment:

```ts
          // Test gate (spec §2.1): a change of ≥3 files runs the tests of the
          // packages it touched. The typecheck alone let two v2 trials ship
          // regressions in files they never opened. Own cap, so a suite that
          // was red before the run still terminates.
          if (
            this.mutatedFiles.size >= VERIFIER_MIN_FILES &&
            this.testAttempts < MAX_TEST_ATTEMPTS
          ) {
            const settings = loadVerifySettings(this.state.projectPath);
            const commands = settings.tests
              ? resolveTestCommands(this.state.projectPath, [...this.mutatedFiles], settings)
              : [];
            if (commands.length === 0) {
              this.lastTestResult = settings.tests ? "skipped (no test script found)" : "skipped (turned off)";
            } else {
              this.testAttempts += 1;
              const failures: { label: string; raw: string }[] = [];
              for (const c of commands) {
                console.log(`[AgentLoop] Test gate ${this.testAttempts}/${MAX_TEST_ATTEMPTS}: running \`${c.command}\``);
                const startedAt = Date.now();
                const r = await runVerify(c.command, this.state.projectPath, this.abort.signal, TEST_TIMEOUT_MS);
                if (this.abort.signal.aborted)
                  return await this.complete("Interrupted", undefined, undefined, usageSoFar());
                const failing = failingTestLines(r.raw);
                this.recorder.recordVerifyRan("tests", r.ok, Date.now() - startedAt, failing.length);
                if (!r.ok) failures.push({ label: c.label, raw: r.raw });
              }
              this.lastTestResult = failures.length
                ? `failed: ${failures.flatMap((f) => failingTestLines(f.raw)).slice(0, 10).join("; ") || "see output"}`
                : `passed (${commands.map((c) => c.label).join(", ")})`;
              if (failures.length) {
                this.pendingReminders.push(testFailureReminder(failures));
                this.state = { ...this.state, iterationCount: this.state.iterationCount + 1, turnCount: this.state.turnCount + 1 };
                continue;
              }
            }
          }

          // No-callers gate (spec §2.2): once per run, name what this run
          // added that nothing outside tests calls. A nudge, never a block.
          if (
            !this.unwiredChecked &&
            this.preEditContent.size > 0 &&
            process.env.FREECODE_UNWIRED_CHECK !== "0"
          ) {
            this.unwiredChecked = true;
            this.lastUnwired = checkUnwired(this.state.projectPath, this.preEditContent);
            this.recorder.recordUnwiredFlagged(this.lastUnwired.length);
            if (this.lastUnwired.length > 0) {
              this.pendingReminders.push(unwiredReminder(this.lastUnwired));
              this.state = { ...this.state, iterationCount: this.state.iterationCount + 1, turnCount: this.state.turnCount + 1 };
              continue;
            }
          }
```

- [ ] **Step 7: Allowlist the switches for `eval ab`**

In `apps/core/src/eval/ab.ts`, add to the doc comment list and to `VARIABLE_ENV_KEYS`:

```ts
 *   FREECODE_VERIFY_TESTS              `loadVerifySettings`, every finish
 *   FREECODE_UNWIRED_CHECK             the loop's no-callers gate, every finish
```

```ts
  // Read per finish in the loop's test and no-callers gates.
  "FREECODE_VERIFY_TESTS",
  "FREECODE_UNWIRED_CHECK",
```

- [ ] **Step 8: Run to verify they pass**

Run: `cd apps/core && npx tsx --test src/agent/finish-gates-loop.test.ts src/agent/repeated-error-loop.test.ts src/agent/compact-restore-loop.test.ts src/eval/ab.test.ts && npx tsc --noEmit -p . && pnpm -s test`
Expected: the 3 new tests pass; the full core suite passes.

- [ ] **Step 9: Commit**

```bash
git add apps/core/src/agent/loop.ts apps/core/src/agent/finish-gates-loop.test.ts apps/core/src/eval/ab.ts
git commit -m "feat(loop): run the touched packages' tests and name uncalled code before finishing"
```

---

### Task 6: Give the verifier the evidence and the reachability instruction

**Files:**
- Modify: `apps/core/src/agent/subagent.ts` (extract `buildVerifierTask`, new inputs), `apps/core/src/agent/loop.ts` (pass them)
- Test: `apps/core/src/agent/verifier.test.ts`

**Interfaces:**
- Consumes: Task 5's `lastTestResult`, `lastUnwired`.
- Produces: `buildVerifierTask(input: VerifierTaskInput): string` where `VerifierTaskInput = { originalRequest: string; changedFiles: string[]; priorReport?: string; testResult?: string; unwired?: { name: string; file: string; line: number }[] }`; `verifyChanges` input gains optional `testResult` and `unwired`.

- [ ] **Step 1: Write the failing test** (append to `verifier.test.ts`)

```ts
import { buildVerifierTask } from "./subagent.js";

test("the verifier is told what the tests said, what nothing calls, and to trace from an entry point", () => {
  const task = buildVerifierTask({
    originalRequest: "Add agent_send",
    changedFiles: ["src/agent/registry.ts"],
    testResult: "failed: not ok 709 - every implemented handler is declared",
    unwired: [{ name: "attachLoop", file: "src/agent/registry.ts", line: 40 }],
  });
  assert.match(task, /Tests run before finishing: failed: not ok 709/);
  assert.match(task, /attachLoop \(src\/agent\/registry\.ts:40\)/);
  assert.match(task, /trace it from a user entry point/);
  assert.match(task, /written and never read, or built and never called from a real path, is FAIL/);
  assert.match(task, /VERDICT: PASS \| FAIL \| PARTIAL/);
  // Without the new inputs the old contract is unchanged.
  assert.doesNotMatch(buildVerifierTask({ originalRequest: "x", changedFiles: ["a"] }), /Tests run before finishing/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/core && npx tsx --test src/agent/verifier.test.ts`
Expected: FAIL — `buildVerifierTask` is not exported.

- [ ] **Step 3: Implement**

In `agent/subagent.ts`, move the `task` array out of `verifyChanges` into an exported function and extend it:

```ts
export interface VerifierTaskInput {
  originalRequest: string;
  changedFiles: string[];
  priorReport?: string;
  /** The finish-time test gate's result, if it ran (loop.ts). */
  testResult?: string;
  /** Declarations this run added that nothing outside tests calls (unwired.ts). */
  unwired?: { name: string; file: string; line: number }[];
}

export function buildVerifierTask(input: VerifierTaskInput): string {
  return [
    "Independently and adversarially verify the work that was just completed.",
    "",
    `Original user request:\n${input.originalRequest}`,
    "",
    `Files changed:\n${input.changedFiles.map((f) => `- ${f}`).join("\n")}`,
    ...(input.testResult ? ["", `Tests run before finishing: ${input.testResult}`] : []),
    ...(input.unwired?.length
      ? ["", "Added in this run and called by nothing outside tests:", ...input.unwired.map((d) => `- ${d.name} (${d.file}:${d.line})`)]
      : []),
    "",
    "Read the changed files and confirm they actually satisfy the request and are",
    "correct. Run any read-only checks you can (search, read, type inspection).",
    "Do NOT modify any files.",
    "",
    "Reachability: for each new function, flag, option or field, trace it from a",
    "user entry point (CLI command, tool, IPC handler, config read) to where it",
    "takes effect. Something written and never read, or built and never called",
    "from a real path, is FAIL — parts that each pass a unit test but are not",
    "connected do not satisfy the request.",
    "",
    "Scope discipline: only fail the request as stated. Missing edge-case",
    "handling, extra validation, or additional tests that were never asked for",
    "are NOT grounds for FAIL — that is the most common false failure.",
    "Missing tests alone are not grounds for FAIL either, unless the request was",
    "itself to add tests.",
    "",
    "Honesty check: if the response claims changes to a file that is not in the",
    "Files changed list above, that is fabrication — FAIL.",
    input.priorReport
      ? [
          "",
          `Prior verification round found:\n${input.priorReport}`,
          "",
          "This is a re-check. Focus on whether each prior finding is actually",
          "fixed. Do not raise a new objection this round unless it is a genuine",
          "defect or unmet part of the original request — the bar does not rise",
          "between rounds, and endless fresh nitpicks make the request unfinishable.",
        ].join("\n")
      : "",
    "",
    "Finish your final message with a single line in exactly this form:",
    "VERDICT: PASS | FAIL | PARTIAL",
    "- PASS only if the change is correct and complete.",
    "- FAIL if it is broken, incorrect, or does not meet the request.",
    "- PARTIAL if you could not fully verify it.",
    "List specific findings above the verdict line.",
  ].join("\n");
}
```

Then in `verifyChanges`, add `testResult?: string; unwired?: VerifierTaskInput["unwired"];` to its input type and replace the inline `const task = [ … ].join("\n");` with `const task = buildVerifierTask(input);`.

In `agent/loop.ts`, extend the `verifyChanges({ … })` call:

```ts
              testResult: this.lastTestResult,
              unwired: this.lastUnwired,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/core && npx tsx --test src/agent/verifier.test.ts src/agent/finish-gates-loop.test.ts && npx tsc --noEmit -p .`
Expected: pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/agent/subagent.ts apps/core/src/agent/loop.ts apps/core/src/agent/verifier.test.ts
git commit -m "feat(verifier): see the test result and uncalled code, trace from an entry point"
```

---

### Task 7: Eval case, `eval ab`, docs

**Files:**
- Modify: `evals/coding.jsonl` (append one case), `ENV.md`, `CLAUDE.md`, `TODO.md`, `docs/specs/2026-10-13-finish-time-verification.md`

- [ ] **Step 1: Add the eval case**

It touches 3 files (so the test gate runs) and its checker only goes through the CLI, so a "built but not wired" answer fails. Append with a script (keeps the JSON exact):

```bash
python3 - <<'EOF'
import json
case = {
  "id": "wire-a-new-flag-through-the-cli",
  "prompt": "Add a `--shout` flag to the CLI that prints the greeting in upper case. Put the upper-casing in a new module lib/shout.mjs exporting `shout(text)`, and document the flag in README.md. Do not modify check.mjs.",
  "failureCategory": "code-edit",
  "whyModelBacked": "Finish-time verification spec 2026-10-13: long tasks built features whose parts each passed a unit test but were never connected to the entry point. Only a real turn shows whether the agent wires the new module into cli.mjs, and whether the finish-time test run (3 changed files) catches it when it does not.",
  "files": {
    "package.json": json.dumps({"type": "module", "scripts": {"test": "node check.mjs"}}),
    "cli.mjs": "import { greet } from \"./lib/greet.mjs\";\nconst args = process.argv.slice(2);\nconst name = args.find((a) => !a.startsWith(\"--\")) ?? \"world\";\nconsole.log(greet(name));\n",
    "lib/greet.mjs": "export function greet(name) {\n  return `Hello, ${name}!`;\n}\n",
    "README.md": "# greet\n\n`node cli.mjs <name>` prints a greeting.\n",
    "check.mjs": "import { execFileSync } from 'node:child_process';\nimport assert from 'node:assert';\nconst run = (...a) => execFileSync('node', ['cli.mjs', ...a], { encoding: 'utf-8' }).trim();\nassert.equal(run('Ann'), 'Hello, Ann!');\nassert.equal(run('--shout', 'Ann'), 'HELLO, ANN!');\nconst { shout } = await import('./lib/shout.mjs');\nassert.equal(shout('hi'), 'HI');\nconsole.log('ok');\n"
  },
  "verify": "node check.mjs",
  "immutable": ["check.mjs"],
  "expectMaxTurns": 14
}
with open("evals/coding.jsonl", "a") as f:
    f.write(json.dumps(case) + "\n")
EOF
cd apps/core && npx tsx --test src/eval/dataset.test.ts
```

Expected: the registry audit passes.

- [ ] **Step 2: Run the A/B (sequential, never in parallel)**

```bash
unset FREECODE_COMPACT_TARGET_TOKENS
pnpm eval ab coding \
  --baseline  env:FREECODE_VERIFY_TESTS=0,env:FREECODE_UNWIRED_CHECK=0 \
  --candidate env:FREECODE_VERIFY_TESTS=1,env:FREECODE_UNWIRED_CHECK=1 \
  --trials 5 \
  --hypothesis "Finish-time tests (>=3 files) and the no-callers check cause no coding regression; on wire-a-new-flag-through-the-cli the test gate catches an unwired flag" \
  --out /tmp/ab-finish.json
```

Expected: no majority regression. Then fold `verify.ran` / `unwired.flagged` from the trials' rollouts (the A/B report lists each trial's `sessionId`; events are in `~/.freecode/rollout/sessions/<id>/events.jsonl`) and note how often each fired per side. Mark the ledger entry in `evals/experiments.jsonl` `kept` or `rejected` with a one-line `note`.

- [ ] **Step 3: Docs**

- `ENV.md`, section "Agent loop behaviour", add:
  - `` | `FREECODE_VERIFY_TESTS` | on | `0` skips the finish-time test run for changes of ≥3 files (`verify.tests: false` in settings). `eval ab`. | ``
  - `` | `FREECODE_VERIFY_TEST_COMMAND` | discovered | Test command to run at finish instead of each changed file's package `test` script (`verify.testCommand`). | ``
  - `` | `FREECODE_UNWIRED_CHECK` | on | `0` turns off the finish-time "nothing calls this" reminder. `eval ab`. | ``
- `CLAUDE.md`: in the "Finish-time verification" row, replace "draft, nothing built" with what was built (modules, gates, defaults, the A/B result).
- `TODO.md`: update the "Finishing without a full test run" and "Built but never wired" entries to point at the spec and say what is left (Phase 4).
- The spec: status line, Phases 2–3 marked built with the A/B numbers.

- [ ] **Step 4: Full verification and commit**

Run: `cd apps/core && pnpm -s test && npx tsc --noEmit -p .`
Expected: all pass.

```bash
git add evals/coding.jsonl evals/experiments.jsonl ENV.md CLAUDE.md TODO.md docs/specs/2026-10-13-finish-time-verification.md
git commit -m "eval: wire-a-new-flag case; finish-time verification A/B and docs"
```

---

## Not in this plan

- **Phase 4** (release, `pnpm bench:image`, rerun the nine long trials, Haiku judge with baseline) — needs a release and the home PC's Docker; shared with the stuck-loop spec's Phase 4.
- #10 (answering repo questions without reading) — separate investigation first.
