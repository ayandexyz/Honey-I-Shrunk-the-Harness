// =============================================================================
// Pathology fold: rollout events → how a run wasted its time. Pure; `pathology-
// run.ts` feeds it files.
//
// Pass/fail cannot see this: a run that passes after forty minutes of reading
// counts the same as one that passes in four. These numbers come from the same
// events.jsonl every session already writes, so the existing history is the
// baseline, at no cost.
//
// The unit is a RUN, i.e. one user prompt. A turnId is a loop iteration and
// restarts at `turn-0` per prompt, so a `model.request` on `turn-0` opens a run
// unless it is a retry inside one (`turn-0` has not answered yet). Keyed on the
// request, not `turn.started`: logs before ~2026-08-20 write `turn.started`
// AFTER the response and never for a prompt's first iteration. Wall clock is
// measured inside a run, so idle time between prompts never counts as a stall.
//
//   progress      an `edit`/`write`, or a bash command that looks like it
//                 writes (BASH_WRITE, a heuristic, counted separately). This
//                 resets the "dry" clock.
//   dry stretch   the longest gap with no progress, in ms and tool calls,
//                 counting the run's start and end as edges.
//   compactions   `compact.occurred` count; `compactNoProgress` counts each one
//                 after the first that came with no progress since the last,
//                 which is the compaction loop. Shrink uses the MEASURED
//                 `inputTokens` on either side, not the event's estimate (that
//                 one undercounts, see TODO.md).
//   rereads       a `read` of the same path+offset+limit seen earlier in the
//                 run, with no edit to that path in between. `rereadsAfterCompact`
//                 is the subset whose first read came before a compaction: the
//                 model re-reading what it forgot.
//   repeatSearch  a grep/glob with byte-identical args and no progress since the
//                 last identical one.
//   repeatCmds    the same for bash: a byte-identical command (that does not
//                 write) with no progress since its last run, e.g. dumping
//                 the same line with `od -c` twice. A re-run of `tsc` after an
//                 edit is not a repeat.
//   stuckError    how often the most frequent error set came back in bash
//                 output: the error-looking lines (TS errors, `not ok`, FAIL,
//                 `Error:`) of one output, timings stripped. Unlike the others
//                 this counts ACROSS edits, which is the point: a run that keeps
//                 editing and keeps getting the same tsc error is not dry, it
//                 is stuck. Found live 2026-10-12: the same 4 errors 5 times in
//                 a run that never looked dry.
//   model wait    the longest request → first token/response/error. A hang is
//                 the provider's (or the fetch layer's) failure, not the model
//                 getting lost, so it is flagged apart as `hung_call`.
//
// A zero-edit run is not by itself a failure, since the user may have asked a
// question. `flags` is a list of things to look at, not a score.
// =============================================================================

import {
  createRepeatedErrors,
  isBashWrite,
  type RepeatedError,
} from "../../apps/core/src/agent/repeated-error.js";

export { isBashWrite };

export interface PathEvent {
  type: string;
  timestamp: number;
  turnId?: string;
  tool?: string;
  args?: Record<string, unknown>;
  callId?: string;
  output?: string;
  duration_ms?: number;
  failed?: boolean | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export type Flag =
  | "long_dry"
  | "compact_loop"
  | "reread_heavy"
  | "search_circles"
  | "repeat_commands"
  | "stuck_error"
  | "hung_call";

export interface RunPathology {
  /** 0-based index of the prompt within its session. */
  run: number;
  startedAt: number;
  durationMs: number;
  /** Model requests, retries included. */
  modelCalls: number;
  longestModelWaitMs: number;
  toolCalls: number;
  failedCalls: number;
  denied: number;
  edits: number;
  /** Of `edits`, how many were bash commands matched by BASH_WRITE. */
  bashWrites: number;
  firstEditMs?: number;
  firstEditCall?: number;
  longestDryMs: number;
  longestDryCalls: number;
  reads: number;
  rereads: number;
  rereadsAfterCompact: number;
  repeatSearches: number;
  repeatCommands: number;
  /** Appearances of the most frequent error set in tool output. */
  stuckErrorRepeats: number;
  /** Signal E (repeated-error.ts): top count of one located, non-baseline error line. */
  repeatedError: RepeatedError;
  compactions: number;
  compactNoProgress: number;
  /** Time spent waiting on the user's answer to `question`; excluded from the clocks. */
  waitingOnUserMs: number;
  /** Measured input-token shrink per compaction, 0..1 (negative = grew). */
  compactShrink: number[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  aborted: boolean;
  flags: Flag[];
}

export const THRESHOLDS = {
  /** long_dry: no progress for this long AND this many calls. */
  dryMs: 15 * 60_000,
  dryCalls: 30,
  /** reread_heavy: share of reads that were rereads, over at least N reads. */
  rereadShare: 0.3,
  rereadMinReads: 10,
  searchCircles: 5,
  repeatCommands: 5,
  stuckError: 4,
  hungMs: 5 * 60_000,
};

const EDIT_TOOLS = new Set(["edit", "write", "notebookedit"]);
const SEARCH_TOOLS = new Set(["grep", "glob"]);
// A search that errored is a broken tool, not a circle. Before 2026-10-13 the
// grep tool logged its errors as `failed: false` with the error as output (the
// v2 long-task image had no `rg`), so old logs are matched by text.
const SEARCH_ERROR = /^(Executable not found in \$PATH|spawn \S+ ENOENT|rg: |regex parse error)/;
// What counts as a write through bash lives with signal E in core
// (`isBashWrite`, agent/repeated-error.ts), so the loop and this fold agree.

// Only these move the run's clock. A run's tail also collects the NEXT prompt's
// `checkpoint.captured` (written before its `turn-0`) and session-end
// `memory.*` events, which would otherwise bill the user's idle hours to it.
// `turn.started` is left out: in the current format it precedes the request
// that opens a run, so it would bill the gap to the previous one.
const ACTIVITY = new Set([
  "turn.aborted",
  "model.request",
  "model.first_token",
  "model.response",
  "model.error",
  "function.call",
  "function.output",
  "function.denied",
  "compact.occurred",
  "message.steered",
]);

// `…Error:` needs a message after it, so source code shown by `cat`
// (`except ValueError:`) is not an error.
const ERROR_LINE = /error TS\d+|^\s*not ok\b|\bFAIL\b|\b[A-Z][a-zA-Z]*Error: \S|✖/;
const TIMING = /\(?\d+(\.\d+)?\s?m?s\)?/g;

/** The error-looking lines of one tool output, order-free; undefined if none. */
export function errorFingerprint(output: string): string | undefined {
  const lines = new Set<string>();
  for (const l of output.split("\n")) if (ERROR_LINE.test(l)) lines.add(l.replace(TIMING, "").trim());
  return lines.size ? [...lines].sort().join("\n") : undefined;
}

const pathOf = (a: Record<string, unknown> | undefined): string | undefined =>
  typeof a?.filePath === "string" ? a.filePath : typeof a?.path === "string" ? a.path : undefined;

function newRun(run: number, at: number): RunPathology {
  return {
    run,
    startedAt: at,
    durationMs: 0,
    modelCalls: 0,
    longestModelWaitMs: 0,
    toolCalls: 0,
    failedCalls: 0,
    denied: 0,
    edits: 0,
    bashWrites: 0,
    longestDryMs: 0,
    longestDryCalls: 0,
    reads: 0,
    rereads: 0,
    rereadsAfterCompact: 0,
    repeatSearches: 0,
    repeatCommands: 0,
    stuckErrorRepeats: 0,
    repeatedError: { max: 0 },
    compactions: 0,
    compactNoProgress: 0,
    waitingOnUserMs: 0,
    compactShrink: [],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    aborted: false,
    flags: [],
  };
}

export function flagsFor(r: RunPathology): Flag[] {
  const f: Flag[] = [];
  if (r.longestDryMs >= THRESHOLDS.dryMs && r.longestDryCalls >= THRESHOLDS.dryCalls) f.push("long_dry");
  if (r.compactNoProgress > 0) f.push("compact_loop");
  if (r.reads >= THRESHOLDS.rereadMinReads && r.rereads / r.reads >= THRESHOLDS.rereadShare)
    f.push("reread_heavy");
  if (r.repeatSearches >= THRESHOLDS.searchCircles) f.push("search_circles");
  if (r.repeatCommands >= THRESHOLDS.repeatCommands) f.push("repeat_commands");
  if (r.stuckErrorRepeats >= THRESHOLDS.stuckError) f.push("stuck_error");
  if (r.longestModelWaitMs >= THRESHOLDS.hungMs) f.push("hung_call");
  return f;
}

/** One session's events (in log order) → one entry per user prompt. */
export function foldRuns(events: PathEvent[]): RunPathology[] {
  const runs: RunPathology[] = [];
  let cur: RunPathology | undefined;
  // Per-run state, reset with each run.
  let lastAt = 0;
  let lastProgressAt = 0;
  let callsSinceProgress = 0;
  let progressSinceCompact = true;
  let compactCount = 0;
  let lastInput: number | undefined;
  let pendingCompact = false;
  let readSeen = new Map<string, number>(); // read key → compaction epoch of its first read
  let lastEditEpoch = new Map<string, number>(); // path → event index of last edit
  let readAt = new Map<string, number>(); // read key → event index of last read
  let searchSeen = new Map<string, number>(); // args → progress count when last seen
  let repeatPending = new Set<string>(); // callIds of repeated searches awaiting output
  let progressCount = 0;
  let errorSeen = new Map<string, number>(); // error fingerprint → appearances
  let repeated = createRepeatedErrors();
  const bashCommand = new Map<string, string>(); // callId → command
  let lastBash = ""; // logs from before callIds existed
  const questionAt = new Map<string, number>(); // callId → when the question was asked
  let prevTurn: string | undefined;
  let turn0Answered = false;
  let requestAt: number | undefined;

  const closeDry = (at: number) => {
    if (!cur) return;
    cur.longestDryMs = Math.max(cur.longestDryMs, at - lastProgressAt);
    cur.longestDryCalls = Math.max(cur.longestDryCalls, callsSinceProgress);
  };
  const finish = () => {
    if (!cur) return;
    closeDry(lastAt);
    cur.repeatedError = repeated.peak();
    cur.durationMs = lastAt - cur.startedAt - cur.waitingOnUserMs;
    cur.flags = flagsFor(cur);
    runs.push(cur);
  };
  const progress = (at: number) => {
    if (!cur) return;
    closeDry(at);
    lastProgressAt = at;
    callsSinceProgress = 0;
    progressSinceCompact = true;
    progressCount++;
    if (cur.firstEditMs === undefined) {
      cur.firstEditMs = at - cur.startedAt;
      cur.firstEditCall = cur.toolCalls;
    }
  };

  events.forEach((e, i) => {
    if (!ACTIVITY.has(e.type)) return;
    if (
      e.type === "model.request" &&
      e.turnId === "turn-0" &&
      (!cur || prevTurn !== "turn-0" || turn0Answered)
    ) {
      finish();
      turn0Answered = false;
      requestAt = undefined;
      cur = newRun(runs.length, e.timestamp);
      lastProgressAt = e.timestamp;
      callsSinceProgress = 0;
      progressSinceCompact = true;
      compactCount = 0;
      lastInput = undefined;
      pendingCompact = false;
      readSeen = new Map();
      lastEditEpoch = new Map();
      readAt = new Map();
      searchSeen = new Map();
      repeatPending = new Set();
      errorSeen = new Map();
      repeated = createRepeatedErrors();
      progressCount = 0;
    }
    if (e.turnId !== undefined) prevTurn = e.turnId;
    if (!cur) return;
    lastAt = Math.max(lastAt, e.timestamp);

    switch (e.type) {
      case "model.request":
        cur.modelCalls++;
        requestAt = e.timestamp;
        break;
      case "model.first_token":
      case "model.error":
        if (requestAt !== undefined) cur.longestModelWaitMs = Math.max(cur.longestModelWaitMs, e.timestamp - requestAt);
        requestAt = undefined;
        break;
      case "turn.aborted":
        cur.aborted = true;
        break;
      case "function.denied":
        cur.denied++;
        break;
      case "function.output": {
        if (e.failed === true) cur.failedCalls++;
        if (e.callId && repeatPending.delete(e.callId)) {
          const errored = e.failed === true || (typeof e.output === "string" && SEARCH_ERROR.test(e.output));
          if (!errored) cur.repeatSearches++;
        }
        // Commands only: a `read` shows file content, not a result.
        const fp = e.tool === "bash" && typeof e.output === "string" ? errorFingerprint(e.output) : undefined;
        if (e.tool === "bash" && typeof e.output === "string") {
          repeated.output((e.callId && bashCommand.get(e.callId)) ?? lastBash, e.output);
        }
        if (fp) {
          const n = (errorSeen.get(fp) ?? 0) + 1;
          errorSeen.set(fp, n);
          cur.stuckErrorRepeats = Math.max(cur.stuckErrorRepeats, n);
        }
        if (e.tool === "question") {
          // The user's think time is neither the agent's work nor its stall.
          // `duration_ms` first: logs before callIds existed still carry it.
          const asked = e.callId !== undefined ? questionAt.get(e.callId) : undefined;
          const wait = e.duration_ms ?? (asked !== undefined ? e.timestamp - asked : 0);
          cur.waitingOnUserMs += wait;
          lastProgressAt += wait;
          if (e.callId) questionAt.delete(e.callId);
        }
        break;
      }
      case "model.response":
        if (requestAt !== undefined) cur.longestModelWaitMs = Math.max(cur.longestModelWaitMs, e.timestamp - requestAt);
        requestAt = undefined;
        if (e.turnId === "turn-0") turn0Answered = true;
        if (pendingCompact && lastInput && e.inputTokens !== undefined)
          cur.compactShrink.push(1 - e.inputTokens / lastInput);
        pendingCompact = false;
        lastInput = e.inputTokens ?? lastInput;
        cur.inputTokens += e.inputTokens ?? 0;
        cur.outputTokens += e.outputTokens ?? 0;
        cur.cacheReadTokens += e.cacheReadTokens ?? 0;
        break;
      case "compact.occurred":
        cur.compactions++;
        if (compactCount > 0 && !progressSinceCompact) cur.compactNoProgress++;
        compactCount++;
        progressSinceCompact = false;
        pendingCompact = true;
        break;
      case "function.call": {
        cur.toolCalls++;
        callsSinceProgress++;
        const tool = e.tool ?? "";
        const p = pathOf(e.args);
        if (tool === "question" && e.callId) questionAt.set(e.callId, e.timestamp);
        if (tool === "bash" && typeof e.args?.command === "string") {
          lastBash = e.args.command;
          if (e.callId) bashCommand.set(e.callId, e.args.command);
        }
        if (EDIT_TOOLS.has(tool)) {
          repeated.edit();
          cur.edits++;
          if (p) lastEditEpoch.set(p, i);
          progress(e.timestamp);
        } else if (tool === "bash" && typeof e.args?.command === "string" && isBashWrite(e.args.command)) {
          repeated.edit();
          cur.edits++;
          cur.bashWrites++;
          progress(e.timestamp);
        } else if (tool === "read" && p) {
          cur.reads++;
          const key = `${p}\0${e.args?.offset ?? ""}\0${e.args?.limit ?? ""}`;
          const prevAt = readAt.get(key);
          if (prevAt !== undefined && (lastEditEpoch.get(p) ?? -1) < prevAt) {
            cur.rereads++;
            if ((readSeen.get(key) ?? compactCount) < compactCount) cur.rereadsAfterCompact++;
          }
          if (!readSeen.has(key)) readSeen.set(key, compactCount);
          readAt.set(key, i);
        } else if (SEARCH_TOOLS.has(tool)) {
          const key = `${tool}\0${JSON.stringify(e.args ?? {})}`;
          // Scored when the output arrives (it may be an error); logs from
          // before callIds existed are scored here, as before.
          if (searchSeen.get(key) === progressCount) {
            if (e.callId) repeatPending.add(e.callId);
            else cur.repeatSearches++;
          }
          searchSeen.set(key, progressCount);
        } else if (tool === "bash" && typeof e.args?.command === "string") {
          const key = `bash\0${e.args.command}`;
          if (searchSeen.get(key) === progressCount) cur.repeatCommands++;
          searchSeen.set(key, progressCount);
        }
        break;
      }
    }
  });
  finish();
  return runs;
}

// ---------------------------------------------------------------------------
// Aggregate across runs.

const pct = (xs: number[], p: number): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export interface PathologyReport {
  runs: number;
  /** Runs with at least this many tool calls; the rest are chat. */
  substantive: number;
  flagged: Record<Flag, number>;
  withEdits: number;
  firstEditMs: { p50?: number; p90?: number };
  longestDryMs: { p50?: number; p90?: number };
  rereadShare?: number;
  rereadsAfterCompact: number;
  compactions: number;
  compactNoProgress: number;
  compactShrinkP50?: number;
}

export const SUBSTANTIVE_CALLS = 10;

export function aggregate(runs: RunPathology[]): PathologyReport {
  const sub = runs.filter((r) => r.toolCalls >= SUBSTANTIVE_CALLS);
  const flagged: Record<Flag, number> = { long_dry: 0, compact_loop: 0, reread_heavy: 0, search_circles: 0, repeat_commands: 0, stuck_error: 0, hung_call: 0 };
  for (const r of sub) for (const f of r.flags) flagged[f]++;
  const firstEdit = sub.flatMap((r) => (r.firstEditMs === undefined ? [] : [r.firstEditMs]));
  const reads = sub.reduce((n, r) => n + r.reads, 0);
  const rereads = sub.reduce((n, r) => n + r.rereads, 0);
  return {
    runs: runs.length,
    substantive: sub.length,
    flagged,
    withEdits: sub.filter((r) => r.edits > 0).length,
    firstEditMs: { p50: pct(firstEdit, 0.5), p90: pct(firstEdit, 0.9) },
    longestDryMs: { p50: pct(sub.map((r) => r.longestDryMs), 0.5), p90: pct(sub.map((r) => r.longestDryMs), 0.9) },
    rereadShare: reads ? rereads / reads : undefined,
    rereadsAfterCompact: sub.reduce((n, r) => n + r.rereadsAfterCompact, 0),
    compactions: sub.reduce((n, r) => n + r.compactions, 0),
    compactNoProgress: sub.reduce((n, r) => n + r.compactNoProgress, 0),
    compactShrinkP50: pct(sub.flatMap((r) => r.compactShrink), 0.5),
  };
}

/** Rank for "look at this first": flags, then longest dry stretch. */
export function severity(r: RunPathology): number {
  return r.flags.length * 1e9 + r.longestDryMs;
}
