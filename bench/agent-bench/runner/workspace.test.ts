import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CACHE_DIR } from "./instances.js";
import { assertNoFutureHistory, createWorkspace } from "./workspace.js";
import type { Instance } from "./types.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

/** base → "Fixed #1" on main, plus a branch and a tag that also carry the fix. */
function upstream(): { dir: string; base: string; fix: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-upstream-"));
  git(dir, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.py"), "bug = True\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "a.py"), "bug = False\n");
  git(dir, "commit", "--quiet", "-am", "Fixed #1 -- the answer");
  const fix = git(dir, "rev-parse", "HEAD");
  git(dir, "branch", "stable", fix);
  git(dir, "tag", "v2", fix);
  return { dir, base, fix };
}

test("a workspace holds no commit after baseCommit, by any route", () => {
  const up = upstream();
  const inst = {
    instanceId: "leak-test",
    repo: `test/leak-${process.pid}`,
    baseCommit: up.base,
    problemStatement: "",
    source: up.dir,
  } as Instance;
  const ws = createWorkspace(inst);
  try {
    assert.equal(git(ws.dir, "rev-parse", "HEAD"), up.base);
    assert.equal(git(ws.dir, "log", "--all", "--oneline").includes("Fixed #1"), false);
    assert.equal(git(ws.dir, "tag"), "");
    assert.equal(git(ws.dir, "remote"), "");
    assert.equal(fs.existsSync(path.join(ws.dir, ".git/objects/info/alternates")), false);
    // The store itself, not just the refs: an unreferenced object is still readable.
    const all = git(ws.dir, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)");
    assert.equal(all.includes(up.fix), false);
  } finally {
    ws.cleanup();
    fs.rmSync(up.dir, { recursive: true, force: true });
    fs.rmSync(path.join(CACHE_DIR, "repos/base", `test__leak-${process.pid}@${up.base}.git`), {
      recursive: true,
      force: true,
    });
  }
});

test("assertNoFutureHistory throws on a full clone", () => {
  const up = upstream();
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "ws-full-"));
  try {
    git(clone, "clone", "--quiet", up.dir, ".");
    git(clone, "checkout", "--quiet", "--detach", up.base);
    assert.throws(() => assertNoFutureHistory(clone, up.base), /leaks history/);
  } finally {
    fs.rmSync(clone, { recursive: true, force: true });
    fs.rmSync(up.dir, { recursive: true, force: true });
  }
});

test("baseline checks run once on the untouched parent, in their own workspace", async () => {
  const { runBaselineChecks, BASELINE_FILE } = await import("./judged-trial.js");
  const up = upstream();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ws-baseline-"));
  const inst = {
    instanceId: "baseline-test",
    repo: `test/baseline-${process.pid}`,
    baseCommit: up.base,
    problemStatement: "",
    source: up.dir,
    initCommand: "touch .setup-ran",
    // Reads the parent's file; leaves a stray file a trial's patch must never see.
    finalCheckCommands: ["test -f .setup-ran && grep -q 'bug = True' a.py && touch stray"],
  } as Instance;
  try {
    runBaselineChecks(inst, out);
    const file = path.join(out, "baseline-test", BASELINE_FILE);
    const [check] = JSON.parse(fs.readFileSync(file, "utf-8"));
    assert.equal(check.exitCode, 0);
    // Kept, not recomputed (--first-trial, --baseline-only).
    fs.writeFileSync(file, "[]");
    runBaselineChecks(inst, out);
    assert.equal(fs.readFileSync(file, "utf-8"), "[]");
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(up.dir, { recursive: true, force: true });
    fs.rmSync(path.join(CACHE_DIR, "repos/base", `test__baseline-${process.pid}@${up.base}.git`), {
      recursive: true,
      force: true,
    });
  }
});
