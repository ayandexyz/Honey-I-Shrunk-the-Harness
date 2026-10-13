// =============================================================================
// Scratch-script hint (spec 2026-10-13-stuck-loop-recovery.md §4.4, Phase 5).
//
// A probe script written to /tmp cannot resolve the project's node_modules or
// its relative imports, so it fails with "Cannot find module" and the agent
// detours: the long-task run's stuck trial searched node_modules/.pnpm for the
// package. The spec proposed a line in every prompt; measured, this happens in
// ~0.3% of sessions (11 module failures in ~3,000 recorded sessions), so the
// hint is attached only to the output that shows the failure — zero tokens
// otherwise, and it arrives exactly when it is useful.
// =============================================================================

// A /tmp script that is RUN (not merely copied or cat'ed): a runtime, then the
// path within the same command segment.
const RUN_SCRATCH =
  /\b(?:node|tsx|bun|deno|ts-node)\b[^|;&\n]*?(\/tmp\/[\w./-]+\.(?:m?js|cjs|m?ts|tsx))\b/g;
const MODULE_NOT_FOUND = /Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/;

export const SCRATCH_HINT =
  "\n<bash_metadata>\nThis script runs from /tmp, which cannot see the project's node_modules or " +
  "resolve its relative imports. Put the probe inside the project (e.g. ./scratch-probe.mjs, " +
  "deleted afterwards) or import project files by absolute path.\n</bash_metadata>";

/**
 * The hint to append to a bash result, or "" when it does not apply. A script
 * under `cwd` is inside the project even when the project lives in /tmp (an
 * eval sandbox), so it is not a scratch script.
 */
export function scratchScriptHint(command: string, output: string, cwd = ""): string {
  if (!MODULE_NOT_FOUND.test(output)) return "";
  const inside = (p: string) => cwd !== "" && p.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`);
  for (const m of command.matchAll(RUN_SCRATCH)) if (!inside(m[1]!)) return SCRATCH_HINT;
  return "";
}
