// =============================================================================
// Workspace — a fresh checkout at the commit before the fix landed, and the
// patch the agent produced in it.
//
// One bare mirror per repo, cached; from it one history-limited bare repo per
// base commit (ensureBaseRepo), and from that every trial gets its own clone.
// Cloning django from the network 30 times would dominate the wall-clock column
// and would also mean the benchmark measures GitHub's mood.
// =============================================================================

import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CACHE_DIR } from "./instances.js";
import type { Instance } from "./types.js";

const MIRRORS = path.join(CACHE_DIR, "repos");

// `-c` overrides rather than inheriting the operator's global git config: the
// first smoke run emitted `c/`…`i/` path prefixes instead of `a/`…`b/`, because
// this machine has `diff.mnemonicPrefix` on. The SWE-bench grader applies the
// model patch with `git apply`, which would have rejected every one of them —
// a config file on one laptop silently scoring every agent zero.
// `stdio: pipe` because execFileSync otherwise forwards git's stderr to ours,
// which put "HEAD is now at …" in the middle of the results table.
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "diff.mnemonicPrefix=false", "-c", "diff.noprefix=false", ...args],
    {
      cwd,
      encoding: "utf-8",
      maxBuffer: 64 << 20,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

export function ensureMirror(repo: string): string {
  const dir = path.join(MIRRORS, `${repo.replace("/", "__")}.git`);
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(MIRRORS, { recursive: true });
  execFileSync(
    "git",
    ["clone", "--mirror", `https://github.com/${repo}.git`, dir],
    { stdio: "inherit" },
  );
  return dir;
}

export interface Workspace {
  dir: string;
  cleanup: () => void;
}

/**
 * A bare repo holding ONLY `baseCommit` and its ancestors, cached per commit.
 *
 * The full mirror carries every later commit, branch and tag — including the
 * fix itself. A 2026-10-11 Sonnet 5 trial ran `git log --all | grep duration`,
 * found "Fixed #30232", and `git show`ed the answer. Deleting refs afterwards
 * is not enough: `git cat-file --batch-all-objects` still lists every object
 * in the store (or behind an alternates link), so the future must never be
 * copied in. Fetching one sha moves exactly the objects reachable from it.
 */
function ensureBaseRepo(source: string, repo: string, baseCommit: string): string {
  const dir = path.join(MIRRORS, "base", `${repo.replace("/", "__")}@${baseCommit}.git`);
  if (fs.existsSync(dir)) return dir;
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  git(tmp, "init", "--bare", "--quiet");
  git(tmp, "fetch", "--quiet", "--no-tags", path.resolve(source), `${baseCommit}:refs/heads/base`);
  git(tmp, "symbolic-ref", "HEAD", "refs/heads/base");
  // Rename last, so an interrupted build never passes for a finished one.
  fs.renameSync(tmp, dir);
  return dir;
}

/**
 * Throws unless every commit the workspace can reach — or merely holds — is
 * `baseCommit` or one of its ancestors. The leak this guards against scored
 * as a fair fix, so it fails the trial loudly instead.
 */
export function assertNoFutureHistory(dir: string, baseCommit: string): void {
  const count = (...args: string[]) => Number(git(dir, ...args).trim());
  const ancestors = count("rev-list", "--count", baseCommit);
  const reachable = count("rev-list", "--count", "--all");
  const stored = git(dir, "cat-file", "--batch-all-objects", "--batch-check=%(objecttype)")
    .split("\n")
    .filter((t) => t === "commit").length;
  if (reachable !== ancestors || stored !== ancestors) {
    throw new Error(
      `workspace ${dir} leaks history past ${baseCommit}: ` +
        `${ancestors} ancestors, ${reachable} reachable, ${stored} stored commits`,
    );
  }
}

/**
 * A checkout at `baseCommit` — the state of the repo the moment BEFORE the fix
 * landed. Detached HEAD on purpose: there is no branch to accidentally push and
 * `git diff` against the index is the whole result.
 */
export function createWorkspace(inst: Instance): Workspace {
  // The judged set clones from the local repo: its commits may not be pushed.
  const source = inst.source ?? ensureMirror(inst.repo);
  const base = ensureBaseRepo(source, inst.repo, inst.baseCommit);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bench-"));
  // A plain local clone (hardlinks or a copy), not `--shared`: an alternates
  // link would point the workspace back at a store the agent can read.
  execFileSync("git", ["clone", "--quiet", "--no-checkout", base, dir], {
    stdio: "pipe",
  });
  git(dir, "checkout", "--quiet", "--detach", inst.baseCommit);
  git(dir, "branch", "--quiet", "-D", "base");
  git(dir, "remote", "remove", "origin");
  assertNoFutureHistory(dir, inst.baseCommit);
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export interface Patch {
  diff: string;
  /** Untracked files the agent added — scratch notes, agent config, caches. */
  newFiles: string[];
}

/**
 * Everything the agent changed, as one patch.
 *
 * Staged rather than plain `git diff`, because an agent that creates a new
 * module has produced a real fix that a tracked-only diff would silently drop.
 * The cost is that scratch files land in the patch too, so they are listed
 * separately — a fix accompanied by six `notes-*.md` is a fact about the agent
 * worth seeing, not something to quietly filter.
 */
export function extractPatch(dir: string): Patch {
  const before = new Set(
    git(dir, "ls-files").split("\n").filter(Boolean),
  );
  git(dir, "add", "-A");
  const after = git(dir, "ls-files").split("\n").filter(Boolean);
  const newFiles = after.filter((f) => !before.has(f));
  // Explicit prefixes and no external difftool: this string is fed to
  // `git apply` by a grader that is not on this machine.
  const diff = git(
    dir,
    "diff",
    "--cached",
    "--no-color",
    "--no-ext-diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  );
  return { diff, newFiles };
}

/** True when the workspace is a usable git checkout at the expected commit. */
export function verifyWorkspace(dir: string, baseCommit: string): boolean {
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf-8",
  });
  return head.status === 0 && head.stdout.trim() === baseCommit;
}
