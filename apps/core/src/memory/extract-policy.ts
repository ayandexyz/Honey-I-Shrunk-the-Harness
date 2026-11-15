// =============================================================================
// Extraction policy - decides WHETHER a completed run gets mined for memories.
// Extraction is a fresh, full-price provider call (unlike claude-code's forked
// agent, which rides the parent's prompt cache), so the default cadence follows
// jcode's: every N runs plus on topic change, not every turn.
// Spec: 2026-08-09-memory-write-path.md, D5.
// =============================================================================

import {
  isBool,
  isNumberAtLeast,
  pickSetting,
  settingsSections,
} from "../settings/load.js";
import { lexicalSimilarity } from "./graph/index.js";

// Extract every N completed runs. Deliberately more conservative than jcode's
// PERIODIC_EXTRACTION_INTERVAL of 12 is aggressive-relative-to-cost: theirs
// rides a cheap local judge, ours is a provider round trip.
export const DEFAULT_INTERVAL_RUNS = 8;
// Below this there is nothing to mine — "fix the typo" never held a memory.
const MIN_TRANSCRIPT_CHARS = 200;
const MIN_TURNS = 2;
// Same threshold the retrieval stash uses for "this is a different topic"
// (graph/index.ts). Reused so the two never disagree about what a topic is.
const TOPIC_SIM_MIN = 0.12;
const MAX_SESSIONS = 64;
const ENV_DISABLE = "FREECODE_DISABLE_MEMORY_EXTRACTION";
const ENV_DISABLE_JUDGE = "FREECODE_DISABLE_MEMORY_JUDGE";
const ENV_DISABLE_RECALL = "FREECODE_DISABLE_MEMORY_RECALL";

export interface ExtractDecisionInput {
  sessionId: string;
  projectRoot: string;
  transcript: string;
  /** Number of user/assistant text turns the transcript covers. */
  turns: number;
  /** Did the model call the memory tool during this run? */
  memoryToolUsed: boolean;
  /** Latest user message, for topic-change detection. */
  userText: string;
  /**
   * End-of-session flush (spec D4). Bypasses the interval gate and **nothing
   * else** — a kill switch a code path can bypass is not a kill switch, and a
   * transcript too short to hold a fact is still too short at session end.
   */
  force?: boolean;
}

export interface ExtractDecision {
  extract: boolean;
  reason: string;
}

interface SessionState {
  runsSinceExtraction: number;
  lastUserText: string;
}

const sessions = new Map<string, SessionState>();

function stateFor(sessionId: string): SessionState {
  const existing = sessions.get(sessionId);
  if (existing) {
    sessions.delete(sessionId); // LRU touch
    sessions.set(sessionId, existing);
    return existing;
  }
  const fresh: SessionState = { runsSinceExtraction: 0, lastUserText: "" };
  sessions.set(sessionId, fresh);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  return fresh;
}

/** Drop policy state for a session (or all of it, in tests). */
export function resetExtractPolicy(sessionId?: string): void {
  if (sessionId === undefined) sessions.clear();
  else sessions.delete(sessionId);
}

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function isEnvFalsy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "0" || v === "false" || v === "no";
}

export interface MemorySettings {
  autoExtract: boolean;
  intervalRuns: number;
  /**
   * Retrieval judge (spec D15). Off → no abstention, no extra call. Off by
   * default since 2026-09-25: head to head the judge was quality- and
   * cost-neutral (spec 2026-09-25 §6.2, ledger 2026-09-25-memory-2).
   */
  retrievalJudge: boolean;
  /**
   * Automatic recall: retrieve and inject relevant memories every request.
   * Off leaves the `memory` tool and the static guidance untouched — it is
   * the "no automatic memory" side of the paired eval (spec 2026-09-25 §6).
   */
  autoRecall: boolean;
}

// Priority chain, project → user → defaults, key by key (`settings/load.ts`).
export function loadMemorySettings(projectRoot: string): MemorySettings {
  const sections = settingsSections(projectRoot, "memory");
  const autoExtract = pickSetting(sections, "autoExtract", isBool);
  const retrievalJudge = pickSetting(sections, "retrievalJudge", isBool);
  const autoRecall = pickSetting(sections, "autoRecall", isBool);
  const everyN = pickSetting(sections, "extractEveryNRuns", isNumberAtLeast(1));
  const intervalRuns = everyN !== undefined ? Math.floor(everyN) : undefined;

  return {
    autoExtract: autoExtract ?? true,
    intervalRuns: intervalRuns ?? DEFAULT_INTERVAL_RUNS,
    // Two-way env, beating the files: `1` forces it off, `0` forces it on, so
    // `eval ab` can select either side whatever the settings say.
    retrievalJudge: isEnvTruthy(process.env[ENV_DISABLE_JUDGE])
      ? false
      : isEnvFalsy(process.env[ENV_DISABLE_JUDGE])
        ? true
        : (retrievalJudge ?? false),
    autoRecall:
      (autoRecall ?? true) && !isEnvTruthy(process.env[ENV_DISABLE_RECALL]),
  };
}

/**
 * Decide whether this completed run should be mined. Gates run cheapest-first,
 * so a skipped run costs a settings read and two string comparisons.
 *
 * Throttling is safe because the transcript is rebuilt from the session's whole
 * history each time: a run that is skipped today is still covered by the next
 * extraction, rather than being lost.
 */
export function shouldExtract(input: ExtractDecisionInput): ExtractDecision {
  if (isEnvTruthy(process.env[ENV_DISABLE])) {
    return { extract: false, reason: `disabled by ${ENV_DISABLE}` };
  }

  const settings = loadMemorySettings(input.projectRoot);
  if (!settings.autoExtract) {
    return { extract: false, reason: "disabled by settings (memory.autoExtract)" };
  }

  const state = stateFor(input.sessionId);

  // The model already recorded what it wanted to keep. Paying a second model to
  // second-guess that is the least valuable call we could make (claude-code
  // does the same via hasMemoryWritesSince).
  if (input.memoryToolUsed) {
    state.runsSinceExtraction = 0;
    state.lastUserText = input.userText;
    return { extract: false, reason: "the model already saved memories this run" };
  }

  state.runsSinceExtraction++;

  if (
    input.transcript.length < MIN_TRANSCRIPT_CHARS ||
    input.turns < MIN_TURNS
  ) {
    state.lastUserText = input.userText;
    return { extract: false, reason: "too short to hold a durable fact" };
  }

  const previous = state.lastUserText;
  state.lastUserText = input.userText;

  if (previous && lexicalSimilarity(input.userText, previous) < TOPIC_SIM_MIN) {
    const runs = state.runsSinceExtraction;
    state.runsSinceExtraction = 0;
    return { extract: true, reason: `topic changed after ${runs} run(s)` };
  }

  // Gate 6, the interval — the only one `force` skips (D4). A session that
  // ends at run 5 used to extract nothing, which is how a preference stated in
  // a one-shot session was lost.
  if (input.force) {
    const runs = state.runsSinceExtraction;
    state.runsSinceExtraction = 0;
    return { extract: true, reason: `session ended after ${runs} run(s)` };
  }

  if (state.runsSinceExtraction >= settings.intervalRuns) {
    const runs = state.runsSinceExtraction;
    state.runsSinceExtraction = 0;
    return { extract: true, reason: `interval reached (${runs} runs)` };
  }

  return {
    extract: false,
    reason: `throttled (${state.runsSinceExtraction}/${settings.intervalRuns})`,
  };
}
