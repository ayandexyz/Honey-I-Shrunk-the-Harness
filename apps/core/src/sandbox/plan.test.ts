// =============================================================================
// The bubblewrap plan: the project read-only, exactly the axes' write roots
// overlaid read-write, a private $HOME and /tmp, and an isolated network when
// the axes say so. One planner for an enveloped agent's shell and an
// unattended night run.
// Spec: docs/specs/2026-09-27-agent-control-and-definitions.md §5.5, §5.9
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync, spawnSync } from "child_process";
import { bubblewrapAvailable } from "./env.js";
import { sandboxPlan, worktreeAxes, type SandboxAxes } from "./plan.js";

/** The `<source> <destination>` pairs of one mount flag, in argv order. */
function bindings(args: string[], flag: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < args.length - 2; i++) {
    if (args[i] === flag) out.push([args[i + 1]!, args[i + 2]!]);
  }
  return out;
}

function axes(projectRoot: string, over: Partial<SandboxAxes> = {}): SandboxAxes {
  return {
    projectRoot,
    rwRoots: [],
    roRoots: [],
    network: true,
    ...over,
  };
}

test("only the write roots are bound read-write, over a read-only root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-plan-"));
  const project = path.join(root, "project");
  const writable = path.join(project, "writable");
  fs.mkdirSync(writable, { recursive: true });
  try {
    const plan = sandboxPlan("pnpm test", project, axes(project, { rwRoots: [writable] }), {
      PATH: "/usr/bin",
    });
    assert.equal(plan.command, "bwrap");
    // The project arrives read-only; a writable agent's boundary is the
    // overlay, not the whole tree.
    const readOnly = bindings(plan.args, "--ro-bind");
    assert.deepEqual(readOnly[0], ["/", "/"]);
    assert.ok(
      readOnly.some(
        ([from, to]) => from === fs.realpathSync(project) && to === fs.realpathSync(project),
      ),
      "the project itself is read-only",
    );
    assert.deepEqual(bindings(plan.args, "--bind"), [
      [fs.realpathSync(writable), fs.realpathSync(writable)],
    ]);
    assert.ok(plan.args.includes("--tmpfs"));
    assert.ok(plan.args.includes(os.homedir()), "the real home is replaced");
    assert.deepEqual(
      plan.args.slice(plan.args.indexOf("--setenv"), plan.args.indexOf("--setenv") + 3),
      ["--setenv", "HOME", "/tmp"],
    );
    assert.deepEqual(plan.args.slice(-3), ["/bin/bash", "-c", "pnpm test"]);
    assert.equal(plan.args[plan.args.indexOf("--chdir") + 1], fs.realpathSync(project));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("network: false isolates the sandbox; shared stays the default", () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-plan-"));
  try {
    const isolated = sandboxPlan("true", tree, axes(tree, { network: false }), {
      PATH: "/usr/bin",
    });
    const shared = sandboxPlan("true", tree, worktreeAxes(tree), { PATH: "/usr/bin" });
    assert.ok(isolated.args.includes("--unshare-net"));
    assert.ok(!shared.args.includes("--unshare-net"));
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("a write root outside the readable roots is an error, not a wider mount", () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-plan-"));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-outside-"));
  try {
    assert.throws(
      () => sandboxPlan("pwd", other, axes(tree, { rwRoots: [] }), { PATH: "/usr/bin" }),
      /outside the project and readable roots/,
    );
    assert.doesNotThrow(() =>
      sandboxPlan("pwd", other, axes(tree, { rwRoots: [other] }), { PATH: "/usr/bin" }),
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});

test("a worktree's git metadata is mounted read-only, so git works inside", () => {
  // Every detached night runs in a worktree, whose `.git` is a FILE pointing
  // into the main repo's .git — under $HOME, which the sandbox hides. The
  // first live run's model got "not a git repository" for every git command.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-repo-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "wt");
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" });
  try {
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(
      repo,
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=a",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    git(repo, "worktree", "add", "-q", "-b", "night/x", worktree);

    const plan = sandboxPlan(
      "git status --short && git log --oneline -1",
      worktree,
      worktreeAxes(worktree),
      { PATH: "/usr/bin" },
    );
    const common = fs.realpathSync(path.join(repo, ".git"));
    assert.ok(
      bindings(plan.args, "--ro-bind").some(
        ([from, to]) => from === common && to === common,
      ),
      "the main repo's .git is bound read-only",
    );

    if (bubblewrapAvailable()) {
      const out = spawnSync(plan.command, plan.args, { encoding: "utf-8" });
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /init/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a plain checkout needs no extra git mount", () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-plan-"));
  try {
    const plan = sandboxPlan("pwd", tree, worktreeAxes(tree), { PATH: "/usr/bin" });
    const allowed = new Set(["/", fs.realpathSync(tree)]);
    for (const [from] of bindings(plan.args, "--ro-bind")) {
      assert.ok(allowed.has(from), `unexpected read-only mount ${from}`);
    }
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("a read root that is already visible is not re-bound", () => {
  // `/` is bound read-only, so a read root outside $HOME and /tmp needs no
  // second mount; only roots inside a tmpfs'd path must come back.
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-plan-"));
  try {
    const plan = sandboxPlan(
      "pwd",
      tree,
      axes(tree, { rwRoots: [], roRoots: ["/usr"] }),
      { PATH: "/usr/bin" },
    );
    assert.ok(
      !bindings(plan.args, "--ro-bind").some(([from]) => from === "/usr"),
      "an already-visible read root is not bound again",
    );
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("a sandboxed shell can execute a user toolchain while the rest of home stays hidden", () => {
  if (!bubblewrapAvailable()) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-toolchain-"));
  const home = path.join(root, "home");
  const tree = path.join(root, "tree");
  const bin = path.join(home, ".local", "tool", "bin");
  const command = path.join(bin, "night-tool");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(tree);
  fs.writeFileSync(command, "#!/bin/sh\nprintf toolchain-visible\n");
  fs.chmodSync(command, 0o755);
  fs.writeFileSync(path.join(home, "secret.txt"), "hidden");
  const env = { PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter) };
  try {
    const plan = sandboxPlan(
      `night-tool && test ! -e ${JSON.stringify(path.join(home, "secret.txt"))}`,
      tree,
      worktreeAxes(tree),
      env,
      home,
    );
    const out = spawnSync(plan.command, plan.args, { encoding: "utf-8", env });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "toolchain-visible");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writes land on the write roots and nowhere else, and the network stays off", () => {
  // The end-to-end claim of the axes: the project is readable, the declared
  // write root is writable, a sibling in the same project is not, and
  // `network: false` really means no network.
  if (!bubblewrapAvailable()) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-run-"));
  const project = path.join(root, "project");
  const writable = path.join(project, "writable");
  fs.mkdirSync(writable, { recursive: true });
  fs.writeFileSync(path.join(project, "readable.txt"), "readable");
  try {
    const plan = sandboxPlan(
      [
        "set -e",
        "cat readable.txt",
        "printf rw > writable/new.txt",
        "test -e writable/new.txt && printf ' rw-ok'",
        "printf leak > readable.txt 2>/dev/null && printf ' RW-LEAK' || printf ' ro-ok'",
        "(bash -c 'exec 3<>/dev/tcp/1.1.1.1/80' 2>/dev/null && printf ' net-open') || printf ' net-closed'",
      ].join("\n"),
      project,
      axes(project, { rwRoots: [writable], network: false }),
      { PATH: "/usr/bin" },
    );
    const out = spawnSync(plan.command, plan.args, {
      encoding: "utf-8",
      timeout: 30_000,
    });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "readable rw-ok ro-ok net-closed");
    assert.ok(
      !fs.existsSync(path.join(project, "new.txt")),
      "nothing leaked into the project root",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
