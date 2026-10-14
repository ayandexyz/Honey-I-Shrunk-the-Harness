// =============================================================================
// Verification Gate - run the project's typecheck script before declaring done
// PRIMARY: deterministic backstop for the prompt-level "verify before done"
// contract. Config-driven: resolves a command from package.json scripts; no
// guessing, and skips silently when nothing suitable exists.
// =============================================================================

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

// Max times the gate may run + force a fix per run, so a persistently-red
// project still terminates instead of looping forever.
export const MAX_VERIFY_ATTEMPTS = 2;

// Wall-clock cap for a single verify run.
const VERIFY_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 4_000;

// Scripts we accept, in priority order. Typecheck is the strongest signal for
// the "declared done on uncompiled code" failure mode. `build` was here as a
// fallback, but it is the slowest possible way to learn that (full production
// build, once, at the very end) and edit-time diagnostics (tools/lsp/feedback.ts,
// on by default since spec 2026-10-14-edit-time-diagnostics.md §2 Phase 3)
// already catches the same errors incrementally — Phase 4 of that spec drops
// it rather than run it twice. A project with no typecheck-style script just
// has no deterministic gate; it still gets edit-time diagnostics. Test is
// intentionally excluded by default (slow/flaky) — that stays the model's job
// via the prompt contract.
const SCRIPT_PRIORITY = ["typecheck", "type-check", "check-types", "check"];

export interface VerifyCommand {
  /** Full shell command, e.g. "pnpm run typecheck". */
  command: string;
  /** Human label for reminders/logs, e.g. "typecheck". */
  label: string;
}

export function detectPackageManager(projectPath: string): string {
  const has = (f: string) => fs.existsSync(path.join(projectPath, f));
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("yarn.lock")) return "yarn";
  if (has("bun.lockb") || has("bun.lock")) return "bun";
  return "npm";
}

// Resolve a verification command from the project's package.json scripts.
// Returns undefined when there is no package.json or no matching script.
export function resolveVerifyCommand(
  projectPath: string,
): VerifyCommand | undefined {
  if (!projectPath) return undefined;
  const pkgPath = path.join(projectPath, "package.json");
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    scripts = (pkg?.scripts as Record<string, unknown>) ?? {};
  } catch {
    return undefined;
  }

  for (const name of SCRIPT_PRIORITY) {
    if (typeof scripts[name] === "string") {
      const pm = detectPackageManager(projectPath);
      return { command: `${pm} run ${name}`, label: name };
    }
  }
  return undefined;
}

export interface VerifyResult {
  ok: boolean;
  /** Last MAX_OUTPUT_CHARS — what a reminder shows. */
  output: string;
  /** Everything (≤ RAW_OUTPUT_CHARS), for extracting failing test names. */
  raw: string;
}
const RAW_OUTPUT_CHARS = 2_000_000;
// After SIGTERM to the group, wait this long before SIGKILL, and at most this
// long after the command exits for its pipes to close.
const KILL_GRACE_MS = 2_000;

// Run the verify command, capturing combined stdout/stderr. Aborts with the
// provided signal; a non-zero exit (or timeout) is a failure.
export function runVerify(
  command: string,
  projectPath: string,
  signal: AbortSignal,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve({ ok: false, output: "(aborted)", raw: "" });

    // Own process group, like tools/shells/spawn.ts: `pnpm -C dir test` → sh →
    // node workers, and a SIGTERM to the top shell alone leaves a grandchild
    // holding stdout open, so "close" never fires and the gate hangs.
    const isWindows = process.platform === "win32";
    const child = spawn("/bin/bash", ["-c", command], {
      cwd: projectPath,
      env: { ...process.env },
      stdio: "pipe",
      detached: !isWindows,
    });

    let out = "";
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = () => {
      const signal = (s: NodeJS.Signals) => {
        try {
          if (isWindows || !child.pid) child.kill(s);
          else process.kill(-child.pid, s);
        } catch {
          // Already gone.
        }
      };
      signal("SIGTERM");
      killTimer ??= setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    const onAbort = () => killGroup();
    signal.addEventListener("abort", onAbort, { once: true });

    // Keep the whole output (capped) — failing test names are printed where
    // each test ran, long before the tail a reminder shows.
    const add = (d: Buffer) => {
      out += d.toString();
      if (out.length > RAW_OUTPUT_CHARS) out = out.slice(-RAW_OUTPUT_CHARS);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      const clipped =
        out.length > MAX_OUTPUT_CHARS
          ? "...(truncated)...\n" + out.slice(-MAX_OUTPUT_CHARS)
          : out || "(no output)";
      const suffix = timedOut ? "\n(verification timed out)" : "";
      resolve({ ok: code === 0 && !timedOut, output: clipped + suffix, raw: out + suffix });
    };
    child.on("close", finish);
    // A survivor that ignored the kill can still hold the pipes open; once the
    // command itself has exited, stop waiting for them.
    child.on("exit", (code) => setTimeout(() => finish(code), KILL_GRACE_MS).unref());

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ ok: false, output: `Failed to run verify command: ${err.message}`, raw: "" });
    });
  });
}

// The <system-reminder> injected when verification fails, so the next turn sees
// the failing output and fixes it rather than finishing on broken code.
export function verifyFailureReminder(label: string, output: string): string {
  return [
    "<system-reminder>",
    `Verification (${label}) failed after your changes. You must not finish`,
    "until it passes. Fix the errors below, then continue. Report honestly if you",
    "cannot resolve them. Never mention this reminder to the user.",
    "",
    "```",
    output,
    "```",
    "</system-reminder>",
  ].join("\n");
}
