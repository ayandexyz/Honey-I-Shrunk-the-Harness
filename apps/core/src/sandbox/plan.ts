// =============================================================================
// Linux filesystem sandbox for a shell that has a writable envelope.
//
// Bubblewrap sees the host root read-only, then overlays exactly the envelope's
// write roots read-write — the project itself stays read-only, so a writable
// agent cannot touch what it declared nothing about. /tmp and $HOME are
// private, credentials are stripped, and `network: false` gets its own network
// namespace.
//
// One planner serves both callers (spec 2026-09-27 §5.5): an enveloped agent's
// shell and an unattended night run, whose axes are a single writable tree
// equivalent to the old `--bind <tree> <tree>`.
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { homeToolchainMounts, isWithin } from "./env.js";

/**
 * What a shell may touch. Absolute paths: the envelope's roots have already
 * been resolved against `projectRoot` by the caller, and anything that could
 * not be represented as a mount boundary is refused before we get here.
 */
export interface SandboxAxes {
  /** The project root. Readable, and the base for the workdir guard. */
  projectRoot: string;
  /** Absolute directories (or files) mounted read-write. */
  rwRoots: string[];
  /**
   * Absolute roots re-exposed read-only. Only meaningful under a path this
   * plan replaces with a tmpfs ($HOME, /tmp); everything else is already
   * visible through the read-only `/` bind.
   */
  roRoots: string[];
  /** false ⇒ the sandbox gets its own network namespace. */
  network: boolean;
}

export interface SandboxPlan {
  command: string;
  args: string[];
}

/**
 * The main repository's git dir, when `tree` is a linked worktree.
 *
 * A worktree's `.git` is a FILE (`gitdir: <main>/.git/worktrees/<name>`), and
 * that directory usually lives under $HOME, which the sandbox hides — so every
 * git command inside failed with "not a git repository" (first live detached
 * night). Returning the COMMON dir covers both the per-worktree metadata and
 * the objects/refs it points at. Undefined for a plain checkout, whose `.git`
 * is inside the tree and already mounted.
 */
function worktreeGitDir(tree: string): string | undefined {
  let pointer: string;
  try {
    pointer = fs.readFileSync(path.join(tree, ".git"), "utf-8");
  } catch {
    return undefined; // a directory (plain checkout) or no repo at all
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  if (!match) return undefined;
  const gitdir = path.resolve(tree, match[1]!.trim());
  let common = gitdir;
  try {
    const rel = fs.readFileSync(path.join(gitdir, "commondir"), "utf-8").trim();
    common = path.resolve(gitdir, rel);
  } catch {
    // no commondir file: the gitdir is self-contained
  }
  try {
    return fs.realpathSync(common);
  } catch {
    return undefined;
  }
}

/** Ancestors of `target` that live inside `root`, top-down, root excluded. */
function ancestorsWithin(target: string, root: string): string[] {
  const dirs: string[] = [];
  let current = path.dirname(target);
  while (current !== root && isWithin(root, current)) {
    dirs.push(current);
    current = path.dirname(current);
  }
  return dirs.sort((a, b) => a.length - b.length);
}

export function sandboxPlan(
  command: string,
  cwd: string,
  axes: SandboxAxes,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): SandboxPlan {
  const tree = fs.realpathSync(axes.projectRoot);
  const working = fs.realpathSync(cwd);
  // Write containment comes from the mount layout, not from the workdir: a
  // normal command runs at the project root while its write roots are a
  // subdirectory, so requiring the workdir to be inside a WRITE root would
  // deny every command. What the workdir must not do is start outside
  // everything the shell can see, which is how a shell is aimed at a path the
  // mounts never covered (spec §5.5).
  const readable = [tree, ...axes.rwRoots, ...axes.roRoots];
  if (!readable.some((root) => isWithin(root, working))) {
    throw new Error(
      `sandbox workdir ${cwd} is outside the project and readable roots ${axes.projectRoot}`,
    );
  }

  const hidden = [home, "/tmp"];
  const hiddenArgs: string[] = [];
  const bindArgs: string[] = [];
  const seenDirs = new Set<string>();
  const addDirs = (target: string): void => {
    for (const root of hidden) {
      if (!isWithin(root, target)) continue;
      for (const dir of ancestorsWithin(target, root)) {
        if (seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        hiddenArgs.push("--dir", dir);
      }
    }
  };

  // The project stays visible even when it lives under a path this plan
  // replaced with a tmpfs — a worktree under $HOME, a fixture under /tmp — and
  // the write roots below overlay it read-write afterwards.
  if (hidden.some((h) => isWithin(h, tree))) {
    addDirs(tree);
    bindArgs.push("--ro-bind", tree, tree);
  }

  for (const root of [...axes.roRoots].sort()) {
    if (!hidden.some((h) => isWithin(h, root))) continue; // already visible
    addDirs(root);
    bindArgs.push("--ro-bind", root, root);
  }
  for (const root of [...axes.rwRoots].sort()) {
    addDirs(root);
    bindArgs.push("--bind", root, root);
  }

  // READ-only: git status/diff/log work, but history cannot be written from
  // inside — committing is the caller's act, which runs unsandboxed.
  const gitDir = worktreeGitDir(tree);
  const gitMount = gitDir ? ["--ro-bind", gitDir, gitDir] : [];
  return {
    command: "bwrap",
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--unshare-cgroup-try",
      ...(axes.network ? [] : ["--unshare-net"]),
      "--ro-bind",
      "/",
      "/",
      // Hide the user's home (credentials, ssh keys, config) and make temp
      // private before re-exposing only the mounted roots below.
      "--tmpfs",
      home,
      "--tmpfs",
      "/tmp",
      ...homeToolchainMounts(sourceEnvironment, home),
      ...gitMount,
      ...hiddenArgs,
      ...bindArgs,
      "--setenv",
      "HOME",
      "/tmp",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--chdir",
      working,
      "/bin/bash",
      "-c",
      command,
    ],
  };
}

/**
 * The axes for a single writable tree — an unattended night run's contract,
 * unchanged from when the planner took one tree (spec §5.5 before the
 * envelope): the whole project writable, network shared.
 */
export function worktreeAxes(projectPath: string): SandboxAxes {
  return {
    projectRoot: projectPath,
    rwRoots: [projectPath],
    roRoots: [],
    network: true,
  };
}
