// =============================================================================
// Prompt-cache miss detector + session cache accounting
// (spec 2026-08-09-cache-observability, D2).
//
// The hit rate says money is being lost. This says which turn lost it, and
// whether the cause was legitimate. Adapted from jcode's KV-cache miss detector
// (crates/jcode-tui/src/tui/app.rs) and its KV cache widget
// (crates/jcode-tui/src/tui/info_widget.rs).
//
// Detection is deliberately conservative: it reports only what cannot happen in
// a healthy session, because a detector that cries wolf gets switched off long
// before it catches anything. An undocumented miss is additionally held for one
// sample before alarming — implicit provider caches (MiniMax, DeepSeek) miss
// for non-rewrite reasons (write latency, eviction), and a read that recovers
// to the pre-miss boundary on the very next call proves the prefix never
// changed. See PendingMiss.
//
// Alongside the alarm, every call updates per-session accounting that the
// frontend renders as `yield · last · session` plus a miss-attribution list
// (getCacheStats). The alarm is for the harness bug class; the stats are for
// the user watching their spend.
// =============================================================================

import { findRecentInvalidation } from "./cache-invalidation.js";
import { getCacheTtl } from "./utils.js";

export type CacheProblemKind =
  | "expected_read_missing"
  | "unexpected_creation";

export interface CacheProblem {
  kind: CacheProblemKind;
  /** Tokens re-sent at full price because of this miss. */
  affectedTokens: number;
  /** Set when the journal explains it — then this is not a bug. */
  documentedCause?: string;
}

/** Which model call a sample belongs to, for the attribution list. */
export interface CacheTurnRef {
  /** 1-based user-prompt ordinal within the session. */
  run: number;
  /** 1-based model call within that run. */
  call: number;
}

export interface CacheUsageSample {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** INCLUSIVE prompt total (non-cached + read + write), as the SDK reports. */
  inputTokens: number;
  provider?: string;
  model?: string;
  turn?: CacheTurnRef;
}

/**
 * Why a request read less than the previous one left cached. The three
 * `harness:` reasons are the bug class D2 alarms on; the rest are legitimate
 * (user-driven or time-driven) and only appear in the attribution list.
 */
export type CacheMissReason =
  | "provider switch"
  | "model switch"
  | "expired"
  | "provider blip"
  | "harness: zero read"
  | "harness: prefix rewritten"
  | { documented: string };

export interface CacheMissSample {
  turn?: CacheTurnRef;
  missedTokens: number;
  reason: string;
  /** True for the two `harness:` reasons — an undocumented rewrite. */
  harnessBug: boolean;
}

/** Wire-shaped summary for the frontend; every ratio is a 0–100 integer. */
export interface CacheStats {
  /**
   * read ÷ what the previous request made cacheable (its full prompt), over
   * the session. The harness-health number: ~100% means the prefix is being
   * reused, whatever the user typed. Undefined until the second call.
   */
  yieldPct?: number;
  /** Same ratio for the latest request alone. */
  lastYieldPct?: number;
  /** read ÷ prompt for the latest request. */
  lastPct?: number;
  /** read ÷ prompt over the session. */
  sessionPct: number;
  /** Most recent misses, oldest first. */
  misses: CacheMissSample[];
}

interface Baseline {
  /** Prefix known to be cached after the previous call. */
  cachedPrefix: number;
  /** Full prompt of the previous call — everything that became cacheable. */
  promptTokens: number;
  /**
   * Bumped when compaction replaces the provider-facing history. A sample from
   * an older generation cannot be judged against the new baseline — mirrors
   * jcode's cache_generation, which exists so the rebuild compaction *must*
   * cause is never reported as a bust.
   */
  generation: number;
  provider?: string;
  model?: string;
  completedAt: number;
}

/**
 * An undocumented miss held for one sample before alarming. Implicit provider
 * caches miss for reasons that are not rewrites — a write that had not
 * committed when the next rapid-fire request arrived, a routing/eviction blip.
 * Measured on MiniMax-M3: read collapsed to 128, then the NEXT turn read
 * exactly the pre-miss boundary — only possible if the prefix bytes never
 * changed. So the verdict waits one sample: a read that recovers to at least
 * `suspectedPrefix` proves the old entry was still valid and the miss was the
 * provider's, not ours. A pending miss with no next sample (session end) is
 * dropped — there is no further spend to warn about.
 */
interface PendingMiss {
  problem: CacheProblem;
  sample: CacheMissSample;
  /** The prefix that was cached before the miss — the recovery bar. */
  suspectedPrefix: number;
  generation: number;
}

interface Totals {
  promptTokens: number;
  readTokens: number;
  optimalTokens: number;
  lastPromptTokens?: number;
  lastReadTokens?: number;
  lastOptimalTokens?: number;
}

/** Below this a shortfall is rounding, not a miss (jcode's threshold). */
const MIN_MISSED_TOKENS = 1_024;
/** Bound on the attribution list — a long session must not grow it forever. */
const MAX_MISS_SAMPLES = 12;

const TTL_MS = { "5m": 5 * 60 * 1000, "1h": 60 * 60 * 1000 } as const;

const baselines = new Map<string, Baseline>();
const generations = new Map<string, number>();
const pendings = new Map<string, PendingMiss>();
const totals = new Map<string, Totals>();
const misses = new Map<string, CacheMissSample[]>();

export function isCacheMissNoticesEnabled(): boolean {
  return process.env.FREECODE_CACHE_MISS_NOTICES !== "0";
}

/** Called when compaction rebuilds history, so the next miss is expected. */
export function bumpCacheGeneration(sessionId: string): void {
  generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
  baselines.delete(sessionId);
  // A pending miss can no longer be judged: recovery would be measured
  // against a prefix compaction just replaced.
  pendings.delete(sessionId);
}

export function resetCacheTracking(sessionId: string): void {
  baselines.delete(sessionId);
  generations.delete(sessionId);
  pendings.delete(sessionId);
  totals.delete(sessionId);
  misses.delete(sessionId);
}

function pct(numerator: number, denominator: number): number {
  return Math.min(100, Math.max(0, Math.round((numerator / denominator) * 100)));
}

/** The session's cache accounting, or undefined before any cache-reporting call. */
export function getCacheStats(sessionId: string): CacheStats | undefined {
  const t = totals.get(sessionId);
  if (!t || t.promptTokens === 0) return undefined;
  return {
    yieldPct: t.optimalTokens > 0 ? pct(t.readTokens, t.optimalTokens) : undefined,
    lastYieldPct:
      t.lastOptimalTokens && t.lastReadTokens !== undefined
        ? pct(t.lastReadTokens, t.lastOptimalTokens)
        : undefined,
    lastPct:
      t.lastPromptTokens && t.lastReadTokens !== undefined
        ? pct(t.lastReadTokens, t.lastPromptTokens)
        : undefined,
    sessionPct: pct(t.readTokens, t.promptTokens),
    misses: [...(misses.get(sessionId) ?? [])],
  };
}

function reasonLabel(reason: CacheMissReason): string {
  return typeof reason === "string" ? reason : reason.documented;
}

function recordMiss(sessionId: string, sample: CacheMissSample): void {
  const list = misses.get(sessionId) ?? [];
  list.push(sample);
  if (list.length > MAX_MISS_SAMPLES) list.shift();
  misses.set(sessionId, list);
}

function accumulate(
  sessionId: string,
  sample: CacheUsageSample,
  previous: Baseline | undefined,
  promptTokens: number,
): void {
  const t = totals.get(sessionId) ?? {
    promptTokens: 0,
    readTokens: 0,
    optimalTokens: 0,
  };
  // What the previous request made cacheable. Only a same-generation baseline
  // counts: after compaction the old prompt is gone, and holding the rebuild
  // turn to it would report a yield miss compaction *must* cause.
  const optimal =
    previous && previous.generation === (generations.get(sessionId) ?? 0)
      ? previous.promptTokens
      : undefined;
  t.promptTokens += promptTokens;
  t.readTokens += sample.cacheReadTokens;
  if (optimal) t.optimalTokens += optimal;
  t.lastPromptTokens = promptTokens;
  t.lastReadTokens = sample.cacheReadTokens;
  t.lastOptimalTokens = optimal;
  totals.set(sessionId, t);
}

/**
 * Judge one response's usage and update the baseline.
 *
 * Returns a problem only when the numbers are inconsistent with a healthy
 * session. Returns undefined — silence — for the normal case, for the first
 * call of a session, and for any provider that does not report cache fields at
 * all (Gemini, OpenAI): absent data must never look like a miss.
 */
export function checkCacheUsage(
  sessionId: string,
  sample: CacheUsageSample,
  now = Date.now(),
): CacheProblem | undefined {
  const generation = generations.get(sessionId) ?? 0;
  const previous = baselines.get(sessionId);

  // A provider that reports neither read nor write is not caching. Recording a
  // zero baseline would make the next caching turn look like a bust. The
  // exception is the same route going silent right after it cached: that is
  // the cache stopping entirely, the miss most worth alarming on, so it is
  // judged below like any other zero read (and held one sample like one).
  const reportsCache = sample.cacheReadTokens > 0 || sample.cacheWriteTokens > 0;
  const stoppedCaching =
    previous !== undefined &&
    previous.generation === generation &&
    previous.cachedPrefix >= MIN_MISSED_TOKENS &&
    sample.provider === previous.provider &&
    sample.model === previous.model;
  if (!reportsCache && !stoppedCaching) {
    baselines.delete(sessionId);
    const pending = pendings.get(sessionId);
    pendings.delete(sessionId);
    // A held miss whose follow-up is silent again on the same route did not
    // recover: the cache is still gone.
    if (
      pending &&
      pending.generation === generation &&
      previous?.provider === sample.provider &&
      previous?.model === sample.model
    ) {
      recordMiss(sessionId, pending.sample);
      return pending.problem;
    }
    return undefined;
  }

  const cachedPrefix = sample.cacheReadTokens + sample.cacheWriteTokens;
  // A provider that omits inputTokens still reported what it cached.
  const promptTokens = Math.max(sample.inputTokens, cachedPrefix);
  accumulate(sessionId, sample, previous, promptTokens);
  baselines.set(sessionId, {
    cachedPrefix,
    promptTokens,
    generation,
    provider: sample.provider,
    model: sample.model,
    completedAt: now,
  });

  // Verdict on last sample's held miss, now that the follow-up is in.
  const pending = pendings.get(sessionId);
  if (pending) {
    pendings.delete(sessionId);
    if (pending.generation === generation) {
      if (sample.cacheReadTokens >= pending.suspectedPrefix) {
        // Recovered to (at least) the pre-miss boundary: the prefix bytes
        // never changed, so the miss was the provider's. No alarm — but the
        // tokens were still re-sent, so the list says so.
        recordMiss(sessionId, {
          ...pending.sample,
          reason: reasonLabel("provider blip"),
          harnessBug: false,
        });
        return undefined;
      }
      // Still below the bar — the entry really is gone. Alarm now, one
      // sample late. The current sample is not separately judged this call
      // (one alarm per call); a persistent rewrite bug keeps producing
      // pendings, so it still surfaces loudly.
      recordMiss(sessionId, pending.sample);
      return pending.problem;
    }
    // Generation moved between miss and verdict: unjudgeable, drop it.
  }

  // Nothing to compare against yet, or history was legitimately rebuilt.
  if (!previous || previous.generation !== generation) return undefined;

  // A prefix can only grow. Reading less than was cached means the bytes at
  // some earlier position changed, so everything after it was re-written —
  // or the entry itself is gone (switch, expiry).
  const missedTokens = previous.cachedPrefix - sample.cacheReadTokens;
  if (missedTokens < MIN_MISSED_TOKENS) return undefined;

  const problem: CacheProblem =
    sample.cacheReadTokens === 0
      ? { kind: "expected_read_missing", affectedTokens: previous.cachedPrefix }
      : { kind: "unexpected_creation", affectedTokens: missedTokens };

  // Legitimate causes first: none of these is a harness bug, so they are
  // attributed in the list and never alarmed.
  const legitimate = classifyLegitimate(sessionId, previous, sample, now);
  if (legitimate) {
    recordMiss(sessionId, {
      turn: sample.turn,
      missedTokens,
      reason: reasonLabel(legitimate),
      harnessBug: false,
    });
    if (typeof legitimate !== "string") {
      problem.documentedCause = legitimate.documented;
      return problem;
    }
    return undefined;
  }

  // Undocumented: hold for one sample. If the next read recovers to the
  // pre-miss boundary this was a provider-side blip, not a rewrite — see
  // PendingMiss.
  pendings.set(sessionId, {
    problem,
    sample: {
      turn: sample.turn,
      missedTokens,
      reason: reasonLabel(
        sample.cacheReadTokens === 0
          ? "harness: zero read"
          : "harness: prefix rewritten",
      ),
      harnessBug: true,
    },
    suspectedPrefix: previous.cachedPrefix,
    generation,
  });
  return undefined;
}

function classifyLegitimate(
  sessionId: string,
  previous: Baseline,
  sample: CacheUsageSample,
  now: number,
): CacheMissReason | undefined {
  const documented = findRecentInvalidation(sessionId, now);
  if (documented) {
    return { documented: `${documented.source}: ${documented.detail}` };
  }
  if (sample.provider && previous.provider && sample.provider !== previous.provider) {
    return "provider switch";
  }
  if (sample.model && previous.model && sample.model !== previous.model) {
    return "model switch";
  }
  // Only Anthropic's cache is time-limited in a way we can name; elsewhere
  // a gap is indistinguishable from eviction and stays a held miss.
  if (
    sample.provider === "anthropic" &&
    now - previous.completedAt > TTL_MS[getCacheTtl()]
  ) {
    return "expired";
  }
  return undefined;
}

/** User-facing line for an undocumented miss. */
export function describeCacheProblem(problem: CacheProblem): string {
  const what =
    problem.kind === "expected_read_missing"
      ? "the prompt cache was not read at all"
      : "part of the cached prefix was re-written";
  return (
    `Prompt-cache miss: ${what} — roughly ${problem.affectedTokens.toLocaleString()} ` +
    `tokens were re-sent at full price with no recorded cause. This usually means ` +
    `something changed an already-sent message.`
  );
}
