// =============================================================================
// Signal E, `repeated_error` (spec 2026-10-13-stuck-loop-recovery.md §4.1):
// the same error line coming back in bash output while the calls and files
// keep changing. Pure and event-fed, so `bench:pathology` calibrates it offline
// (§5.1) and Phase 2 can move it into core without a rewrite.
//
// Per error LINE, not per output: a full test run repeats every pre-existing
// failure, so a whole-output fingerprint fires on errors the agent neither
// caused nor can fix. Three rules keep it to stuck errors:
//   - baseline: a line seen before the run's first edit is never counted;
//   - located: a line must name a place (`file(l,c)`, `file:l:c`) or a test
//     (`not ok N - name`) — a bare verifier verdict (`grade: FAIL`, jcode
//     hill-climbs) has neither;
//   - cleared: a full (unpiped) run of the same command without the line
//     resets it, since the error went away. A piped/filtered run only adds;
//   - after an edit: a line counts again only if a file changed since it last
//     counted. Re-reading one failure (`grep -A30 "not ok 709" full.log` four
//     times) is investigation; the stuck case is "edited, same error back".
// =============================================================================

const ERROR_LINE = /error TS\d+|^\s*not ok\b|\bFAIL\b|\b[A-Z][a-zA-Z]*Error: \S|✖/;
const TIMING = /\(?\d+(\.\d+)?\s?m?s\)?/g;
/** `path(12,3)`, `path:12:3` / `path:12`, or a TAP test name. */
const LOCATED = /[\w./-]+\.\w+(\(\d+,\d+\)|:\d+)|^not ok - \S/;

/** One output's error lines, normalised: timings and TAP numbers stripped. */
export function errorLines(output: string): string[] {
  const lines = new Set<string>();
  for (const raw of output.split("\n")) {
    if (!ERROR_LINE.test(raw)) continue;
    const l = raw.replace(TIMING, "").trim().replace(/^not ok \d+/, "not ok");
    if (LOCATED.test(l)) lines.add(l);
  }
  return [...lines];
}

/** What a command runs, without `cd … &&`, redirects and the pipe filter after it. */
export function commandFamily(command: string): { family: string; filtered: boolean } {
  const main = command.replace(/^\s*cd\s+\S+\s*&&\s*/, "");
  const [head, ...rest] = main.split(/\s*\|\s*/);
  return {
    family: head.replace(/\s*\d?>&\d\s*/g, " ").replace(/\s+/g, " ").trim(),
    filtered: rest.length > 0,
  };
}

export interface RepeatedError {
  /** Highest count any non-baseline line has reached this run. */
  max: number;
  /** The line that reached it (local reports only — never into a rollout log). */
  line?: string;
}

export function createRepeatedErrors() {
  const baseline = new Set<string>();
  const seenFamily = new Set<string>();
  const counts = new Map<string, { n: number; family: string; atEdit: number }>();
  let edits = 0;
  const peak: RepeatedError = { max: 0 };
  return {
    /** Any file change: from now on, new error lines can be the agent's own. */
    edit() {
      edits++;
    },
    output(command: string, output: string) {
      const { family, filtered } = commandFamily(command);
      const lines = errorLines(output);
      // The first full run of a command shows what was already broken, edits
      // or not: an agent that edits before it first runs the suite would
      // otherwise own every pre-existing failure (add-agent-control v2 t3).
      const first = !filtered && !seenFamily.has(family);
      if (!filtered) seenFamily.add(family);
      if (edits === 0 || first) {
        for (const l of lines) baseline.add(l);
        return;
      }
      const present = new Set(lines);
      if (!filtered) {
        for (const [l, c] of counts) if (c.family === family && !present.has(l)) counts.delete(l);
      }
      for (const l of lines) {
        if (baseline.has(l)) continue;
        const c = counts.get(l) ?? { n: 0, family, atEdit: -1 };
        c.family = family;
        if (c.atEdit === edits) continue;
        c.atEdit = edits;
        c.n++;
        counts.set(l, c);
        if (c.n > peak.max) {
          peak.max = c.n;
          peak.line = l;
        }
      }
    },
    peak: (): RepeatedError => ({ ...peak }),
  };
}
