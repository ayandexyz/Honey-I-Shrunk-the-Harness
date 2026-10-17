// =============================================================================
// Sandbox environment and toolchain mounts.
//
// The pieces a sandboxed shell needs before the plan itself: which variables to
// strip, whether bwrap actually works on this machine, and how to re-expose a
// user's toolchains after $HOME is replaced with a tmpfs.
//
// Split out of `autonomous/` so `tools/shells` can plan a sandbox for an
// enveloped agent without depending on the unattended-run feature; the two
// paths share one planner (spec 2026-09-27 §5.5).
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const SENSITIVE_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

const SENSITIVE_HOME_PARTS = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config",
  ".codex",
  ".freecode",
  ".kube",
  ".docker",
  "keyrings",
]);

// A PATH entry is often a small bin directory inside one of these managers.
// Mount the manager root so launchers can still find runtimes and package
// stores beside the executable. All mounts remain read-only.
const TOOLCHAIN_ROOTS = [
  ".local/share/mise",
  ".local/share/pnpm",
  ".nvm",
  ".cargo",
  ".volta",
  ".asdf",
  ".bun",
] as const;

/** Provider credentials stay in FreeCode and never enter arbitrary bash. */
export function sandboxEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !SENSITIVE_ENV.test(name)),
  );
}

export function bubblewrapAvailable(): boolean {
  if (process.platform !== "linux") return false;
  // `--version` succeeds even when the kernel forbids the user namespace that
  // a real sandbox needs. Probe the smallest useful sandbox instead.
  const found = spawnSync(
    "bwrap",
    ["--die-with-parent", "--ro-bind", "/", "/", "--", "/bin/true"],
    { stdio: "ignore" },
  );
  return !found.error && found.status === 0;
}

/**
 * `bubblewrapAvailable()`, probed once per process.
 *
 * The probe spawns a real bwrap, and the answer cannot change under a running
 * process, so the decision sites (which ask per tool call) must not pay for it
 * each time.
 */
let probed: boolean | undefined;
export function sandboxAvailable(): boolean {
  if (probed === undefined) probed = bubblewrapAvailable();
  return probed;
}

export function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isSensitiveHomePath(home: string, candidate: string): boolean {
  if (!isWithin(home, candidate)) return false;
  return path
    .relative(home, candidate)
    .split(path.sep)
    .some((part) => SENSITIVE_HOME_PARTS.has(part));
}

/**
 * Re-expose user-installed toolchains after the home tmpfs is mounted.
 *
 * Only existing PATH entries below home are considered. Known credential and
 * configuration roots stay hidden. Recognized version managers are mounted at
 * their root because their bin entries commonly dispatch to sibling installs.
 */
export function homeToolchainMounts(
  source: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string[] {
  let realHome: string;
  try {
    realHome = fs.realpathSync(home);
  } catch {
    return [];
  }

  const mounts = new Map<string, string>();
  for (const entry of (source.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const destination = path.resolve(entry);
    let realEntry: string;
    try {
      realEntry = fs.realpathSync(destination);
      if (!fs.statSync(realEntry).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!isWithin(realHome, destination)) continue;

    const relative = path.relative(realHome, destination);
    if (
      isSensitiveHomePath(realHome, destination) ||
      isSensitiveHomePath(realHome, realEntry)
    )
      continue;

    const manager = TOOLCHAIN_ROOTS.find(
      (root) => relative === root || relative.startsWith(`${root}${path.sep}`),
    );
    const mountAt = manager ? path.join(realHome, manager) : destination;
    let mountFrom: string;
    try {
      mountFrom = fs.realpathSync(mountAt);
      if (!fs.statSync(mountFrom).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isSensitiveHomePath(realHome, mountFrom)) continue;
    mounts.set(mountAt, mountFrom);

    // rustup keeps its installed toolchains beside ~/.cargo, not below it.
    if (manager === ".cargo") {
      const rustup = path.join(realHome, ".rustup");
      try {
        mounts.set(rustup, fs.realpathSync(rustup));
      } catch {
        // Cargo can also be installed without rustup.
      }
    }
  }

  const directories = new Set<string>();
  for (const destination of mounts.keys()) {
    let current = path.dirname(destination);
    while (current !== realHome && isWithin(realHome, current)) {
      directories.add(current);
      current = path.dirname(current);
    }
  }

  const args: string[] = [];
  for (const directory of [...directories].sort(
    (a, b) => a.length - b.length,
  )) {
    args.push("--dir", directory);
  }
  for (const [destination, sourcePath] of [...mounts].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    args.push("--ro-bind", sourcePath, destination);
  }
  return args;
}
