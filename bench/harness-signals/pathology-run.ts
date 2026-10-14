#!/usr/bin/env tsx
// =============================================================================
// Scan recorded sessions for runs that wasted their time (pathology.ts).
//
//   pnpm bench:pathology                 # summary + the 15 worst runs
//   pnpm bench:pathology --top 40        # more of the ranking
//   pnpm bench:pathology --since 7       # sessions started in the last 7 days
//   pnpm bench:pathology --session <id>  # every run of one session
//   pnpm bench:pathology --rollout-dir D # another root, searched recursively —
//                                        #   e.g. bench/agent-bench/results/<run>
//   pnpm bench:pathology --json          # every run, machine-readable
//
// Free: no model, no network. Writes nothing. Unlike bench:signals it prints
// session ids, because the point is to open the bad ones with `freecode trace
// <id>`. It is a local terminal report and is never published.
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { aggregate, foldRuns, severity, SUBSTANTIVE_CALLS, THRESHOLDS, type PathEvent, type RunPathology } from "./pathology.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const rolloutDir = arg("rollout-dir") ?? path.join(os.homedir(), ".freecode", "rollout", "sessions");
const sinceDays = arg("since") ? Number(arg("since")) : undefined;
const cutoff = sinceDays ? Date.now() - sinceDays * 86_400_000 : 0;
const top = Number(arg("top") ?? 15);
const only = arg("session");

/** Every `<dir>/<session>/events.jsonl` under root, at any depth; label = path from root. */
function findLogs(root: string): { label: string; file: string }[] {
  const out: { label: string; file: string }[] = [];
  const walk = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sub = path.join(dir, d.name);
      const file = path.join(sub, "events.jsonl");
      if (fs.existsSync(file)) out.push({ label: path.relative(root, sub), file });
      else walk(sub);
    }
  };
  walk(root);
  return out;
}

function readEvents(file: string): PathEvent[] {
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .flatMap((l) => {
      if (!l.trim()) return [];
      try {
        return [JSON.parse(l) as PathEvent];
      } catch {
        return [];
      }
    });
}

const min = (ms?: number) => (ms === undefined ? "—" : `${(ms / 60_000).toFixed(1)}m`);
const share = (x?: number) => (x === undefined ? "—" : `${Math.round(x * 100)}%`);

function main() {
  if (!fs.existsSync(rolloutDir)) {
    console.error(`no rollout dir at ${rolloutDir}`);
    process.exit(1);
  }
  const all: (RunPathology & { session: string })[] = [];
  for (const { label: id, file } of findLogs(rolloutDir)) {
    if (only && !path.basename(id).startsWith(only)) continue;
    const events = readEvents(file);
    if (events.length === 0 || (cutoff && (events[0]!.timestamp ?? 0) < cutoff)) continue;
    for (const r of foldRuns(events)) all.push({ ...r, session: id });
  }

  // Spec 2026-10-13-stuck-loop-recovery.md §5.1: how many runs signal E would
  // fire on per threshold, and which, for classifying by hand.
  if (process.argv.includes("--calibrate")) {
    const hits = all.filter((r) => r.repeatedError.max >= 2).sort((a, b) => b.repeatedError.max - a.repeatedError.max);
    console.log(`${all.length} runs. Signal E (repeated_error) would fire on:`);
    for (const t of [2, 3, 4, 5, 6]) console.log(`  threshold ${t}: ${hits.filter((r) => r.repeatedError.max >= t).length}`);
    console.log(`\nruns at ≥2, highest first (top ${top}):`);
    for (const r of hits.slice(0, top)) {
      const where = path.dirname(r.session) === "." ? "" : `  [${path.dirname(r.session).replace(/\/rollout$/, "")}]`;
      console.log(`${String(r.repeatedError.max).padStart(3)}×  ${path.basename(r.session).slice(0, 8)} run ${r.run}${where}`);
      console.log(`       ${(r.repeatedError.line ?? "").slice(0, 140)}`);
    }
    return;
  }

  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify({ thresholds: THRESHOLDS, report: aggregate(all), runs: all }, null, 2) + "\n");
    return;
  }

  const rep = aggregate(all);
  console.log(`${rep.runs} runs (user prompts), ${rep.substantive} with ≥${SUBSTANTIVE_CALLS} tool calls; numbers below are over those.`);
  console.log(`  edited something      ${rep.withEdits}/${rep.substantive}`);
  console.log(`  first edit            p50 ${min(rep.firstEditMs.p50)}  p90 ${min(rep.firstEditMs.p90)}`);
  console.log(`  longest dry stretch   p50 ${min(rep.longestDryMs.p50)}  p90 ${min(rep.longestDryMs.p90)}`);
  console.log(`  reread share          ${share(rep.rereadShare)}  (${rep.rereadsAfterCompact} reread right after a compaction)`);
  console.log(`  compactions           ${rep.compactions}, ${rep.compactNoProgress} with no progress since the last; measured shrink p50 ${share(rep.compactShrinkP50)}`);
  console.log(`  flagged               ${Object.entries(rep.flagged).map(([k, n]) => `${k} ${n}`).join(" · ")}`);

  const ranked = all
    .filter((r) => only || r.toolCalls >= SUBSTANTIVE_CALLS)
    .sort((a, b) => (only ? a.run - b.run : severity(b) - severity(a)))
    .slice(0, only ? undefined : top);
  console.log(`\n${only ? "runs" : `worst ${ranked.length}`}  (open with: freecode trace <session>)`);
  console.log("session   run  date        dur    calls edits 1st-edit  dry(calls)    reads/re  cmp/loop  flags");
  for (const r of ranked) {
    console.log(
      [
        path.basename(r.session).slice(0, 8),
        String(r.run).padStart(4),
        new Date(r.startedAt).toISOString().slice(0, 10),
        min(r.durationMs).padStart(6),
        String(r.toolCalls).padStart(5),
        String(r.edits).padStart(5),
        min(r.firstEditMs).padStart(8),
        `${min(r.longestDryMs)}(${r.longestDryCalls})`.padStart(12),
        `${r.reads}/${r.rereads}`.padStart(9),
        `${r.compactions}/${r.compactNoProgress}`.padStart(8),
        (r.aborted ? "aborted " : "") + r.flags.join(","),
        // Nested under a bench results dir: say which trial it was.
        path.dirname(r.session) === "." ? "" : path.dirname(r.session).replace(/\/rollout$/, ""),
      ].join("  "),
    );
  }
}

main();
