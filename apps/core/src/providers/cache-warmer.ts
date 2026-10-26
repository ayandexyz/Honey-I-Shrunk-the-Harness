// =============================================================================
// Prompt-cache warmer (spec 2026-09-20-pi-parity-plan, Phase 2; ported from
// pi's cache-warmer.ts).
//
// Anthropic's prompt cache lives 5 minutes (1h under FREECODE_CACHE_TTL). A
// user who reads, thinks, or types for longer than that pays to re-write the
// whole prefix on the next turn. This module keeps the entry alive by
// re-sending the LAST request of a run — byte-identical, so it hits every
// breakpoint — with a one-token output cap, at ~90% of the TTL, for as long
// as the expected saving justifies the refresh.
//
// Two facts make the replay safe here that pi has to check for:
//   - Anthropic thinking is driven by `effort` (adaptive), never by a
//     `budget_tokens` derived from `max_tokens`, so capping the output does
//     not change the cache key.
//   - The request is captured AFTER the loop's own pruning/tail placement, so
//     what is replayed is exactly what was cached.
//
// One warmer per session, outside the loop: the server builds a fresh
// AgentLoop per turn, and a warm scheduled by one turn must be cancelled by
// the next turn's first real request.
//
// Off by default until the rollout fold shows the saving (`cache.warm`
// events + the D2 detector can tell a warm from a real turn).
//   settings.json  { "cache": { "warming": "off" | "streaming" | "idle" } }
//   env            FREECODE_CACHE_WARMING=off|streaming|idle  (beats the file)
// "streaming" warms only while the run is active (between tool calls that
// take longer than the TTL — rare); "idle" keeps warming after the run ends,
// which is where the money is.
// =============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AIProvider, ExecuteOptions, ExecuteUsage } from "./types.js";
import { priceFor, type ModelPrice } from "./pricing.js";
import { getCacheTtl } from "./utils.js";

export type CacheWarmingMode = "off" | "streaming" | "idle";

/** Streaming warming never continues past this long after the real request that started it. */
export const MAX_WARMING_AGE_MS = 60 * 60_000;
/** Idle warming uses a shorter horizon because continuation estimates get worse with age. */
export const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
/** A refresh is sent only when it is expected to save at least this many dollars. */
export const MIN_EXPECTED_SAVINGS_USD = 0.05;
/**
 * Chance that a real request arrives before the entry expires while the user
 * is idle. Pi's constant, measured from their usage; per-session estimates
 * were not better. Revisit once `pnpm bench:signals` folds our own.
 */
export const IDLE_CONTINUATION_PROBABILITY = 0.15;

const TTL_MS = { "5m": 5 * 60_000, "1h": 60 * 60_000 } as const;
const MILLION = 1_000_000;

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
export function warmingDelayMs(ttlMs: number): number | undefined {
  if (ttlMs <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

export interface WarmDecision {
  phase: "streaming" | "idle";
  /** Price of this refresh: a cache read of the prompt plus one output token. */
  warmCostUsd: number;
  /** Extra price of the next real request if the entry is lost. */
  missCostUsd: number;
  continuationProbability: number;
  /** `continuationProbability * missCost - warmCost`. */
  expectedSavingsUsd: number;
  /** False when the prompt size or the model's prices are unknown. */
  economicsAvailable: boolean;
  action: "warm" | "stop";
}

/**
 * Pure economics. `promptTokens` is the inclusive prompt total of the request
 * being kept warm (what the provider reported as `inputTokens`).
 */
export function decideWarm(
  price: ModelPrice | undefined,
  promptTokens: number,
  phase: "streaming" | "idle",
): WarmDecision {
  const continuationProbability =
    phase === "idle" ? IDLE_CONTINUATION_PROBABILITY : 1;
  if (!price || promptTokens <= 0) {
    return {
      phase,
      warmCostUsd: 0,
      missCostUsd: 0,
      continuationProbability,
      expectedSavingsUsd: 0,
      economicsAvailable: false,
      action: "stop",
    };
  }
  const read = price.cacheRead ?? price.input;
  const write = price.cacheWrite ?? price.input;
  const hitCost = (promptTokens / MILLION) * read;
  const missCost = (promptTokens / MILLION) * write;
  const warmCostUsd = hitCost + price.output / MILLION;
  const missCostUsd = Math.max(0, missCost - hitCost);
  const expectedSavingsUsd =
    continuationProbability * missCostUsd - warmCostUsd;
  return {
    phase,
    warmCostUsd,
    missCostUsd,
    continuationProbability,
    expectedSavingsUsd,
    economicsAvailable: hitCost > 0 || missCost > 0,
    action: expectedSavingsUsd >= MIN_EXPECTED_SAVINGS_USD ? "warm" : "stop",
  };
}

// --- settings ---------------------------------------------------------------

function readMode(file: string): CacheWarmingMode | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      cache?: { warming?: unknown };
    };
    const v = raw?.cache?.warming;
    return v === "off" || v === "streaming" || v === "idle" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCacheWarmingMode(
  projectRoot: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CacheWarmingMode {
  const fromEnv = env.FREECODE_CACHE_WARMING;
  if (fromEnv === "off" || fromEnv === "streaming" || fromEnv === "idle")
    return fromEnv;
  const files = [
    projectRoot
      ? path.join(projectRoot, ".freecode", "settings.json")
      : undefined,
    path.join(os.homedir(), ".freecode", "settings.json"),
  ];
  for (const f of files) {
    if (!f) continue;
    const m = readMode(f);
    if (m) return m;
  }
  return "off";
}

// --- the warmer -------------------------------------------------------------

/** The request to keep warm, exactly as it was sent, plus what it cost. */
export interface WarmRequest {
  provider: string;
  model: string;
  options: ExecuteOptions;
  /** Inclusive prompt total the provider reported for this request. */
  promptTokens: number;
}

export interface WarmedReport {
  provider: string;
  model: string;
  phase: "streaming" | "idle";
  usage: ExecuteUsage | undefined;
  decision: WarmDecision;
  delayMs: number;
}

export type FailedWarmReport = Omit<WarmedReport, "usage">;

export interface CacheWarmerDeps {
  /** Provider lookup, deferred so tests can inject a fake. */
  getProvider: (id: string) => AIProvider;
  getMode: () => CacheWarmingMode;
  /** Rate card lookup; defaults to pricing.ts. */
  getPrice?: (provider: string, model: string) => ModelPrice | undefined;
  /** Every successful refresh — the loop's rollout/usage bookkeeping. */
  onWarmed?: (report: WarmedReport) => void;
  /** Every provider attempt that failed before reporting usage. */
  onFailed?: (report: FailedWarmReport) => void;
  /** Why warming stopped, for `freecode trace` and debug logs. */
  onStopped?: (reason: string, decision?: WarmDecision) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface ActiveRun extends WarmRequest {
  delayMs: number;
  startedAt: number;
  controller: AbortController;
  phase: "streaming" | "idle";
  nextWarmAt: number;
  timer?: unknown;
  refreshing: boolean;
}

export class CacheWarmer {
  private run?: ActiveRun;
  private readonly deps: Required<
    Pick<CacheWarmerDeps, "now" | "setTimer" | "clearTimer">
  > &
    CacheWarmerDeps;

  constructor(deps: CacheWarmerDeps) {
    this.deps = {
      now: () => Date.now(),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      },
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...deps,
    };
  }

  /** Status for `/session`-style displays and tests. */
  get status(): {
    state: "inactive" | "scheduled" | "refreshing";
    nextWarmAt?: number;
    phase?: "streaming" | "idle";
  } {
    const run = this.run;
    if (!run) return { state: "inactive" };
    return {
      state: run.refreshing ? "refreshing" : "scheduled",
      nextWarmAt: run.nextWarmAt,
      phase: run.phase,
    };
  }

  /** Keep the entry written by `request` warm. Replaces any previous run. */
  start(request: WarmRequest): void {
    this.clearRun();
    if (this.deps.getMode() === "off") return;
    // Only Anthropic's cache is time-limited in a way a replay refreshes.
    if (!isCacheWarmable(request.provider)) return;
    const delayMs = warmingDelayMs(TTL_MS[getCacheTtl()]);
    if (delayMs === undefined) return;
    this.run = {
      ...request,
      delayMs,
      startedAt: this.deps.now(),
      controller: new AbortController(),
      phase: "streaming",
      nextWarmAt: 0,
      refreshing: false,
    };
    this.schedule(this.run);
  }

  /** The run that sent the request has ended; the user is now idle. */
  onRunSettled(): void {
    const run = this.run;
    if (!run) return;
    if (this.deps.getMode() === "streaming") {
      this.stop("run settled");
      return;
    }
    run.phase = "idle";
    const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS;
    if (run.nextWarmAt > deadline || this.deps.now() >= deadline) {
      this.stop("30-minute idle limit reached");
    }
  }

  cancel(): void {
    this.stop("cancelled");
  }

  private clearRun(): void {
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    if (run.timer !== undefined) this.deps.clearTimer(run.timer);
    run.controller.abort();
  }

  private stop(reason: string, decision?: WarmDecision): void {
    this.clearRun();
    this.deps.onStopped?.(reason, decision);
  }

  private schedule(run: ActiveRun): void {
    run.nextWarmAt = this.deps.now() + run.delayMs;
    const deadline =
      run.startedAt +
      (run.phase === "idle" ? MAX_IDLE_WARMING_AGE_MS : MAX_WARMING_AGE_MS);
    if (run.nextWarmAt > deadline || this.deps.now() >= deadline) {
      this.stop(
        run.phase === "idle"
          ? "30-minute idle limit reached"
          : "one-hour limit reached",
      );
      return;
    }
    run.timer = this.deps.setTimer(
      () => void this.refresh(run),
      Math.max(0, run.nextWarmAt - this.deps.now()),
    );
  }

  private async refresh(run: ActiveRun): Promise<void> {
    run.timer = undefined;
    if (this.run !== run) return;
    if (this.deps.getMode() === "off") {
      this.stop("disabled");
      return;
    }
    const price = (this.deps.getPrice ?? priceFor)(run.provider, run.model);
    const decision = decideWarm(price, run.promptTokens, run.phase);
    if (decision.action === "stop") {
      this.stop(
        decision.economicsAvailable
          ? "expected savings below threshold"
          : "economics unavailable",
        decision,
      );
      return;
    }
    run.refreshing = true;
    try {
      const provider = this.deps.getProvider(run.provider);
      const result = await provider.execute({
        ...run.options,
        maxTokens: 1,
        stream: false,
        abortSignal: run.controller.signal,
      });
      if (this.run !== run) return;
      this.deps.onWarmed?.({
        provider: run.provider,
        model: run.model,
        phase: run.phase,
        usage: result.usage,
        decision,
        delayMs: run.delayMs,
      });
    } catch {
      // Best-effort: a failed refresh must never touch the real run. The
      // next tick decides again; a persistent failure ends at the age limit.
      if (this.run === run) {
        this.deps.onFailed?.({
          provider: run.provider,
          model: run.model,
          phase: run.phase,
          decision,
          delayMs: run.delayMs,
        });
      }
    } finally {
      run.refreshing = false;
    }
    if (this.run === run) this.schedule(run);
  }
}

/** Providers whose prompt cache expires on a clock a replay can reset. */
export function isCacheWarmable(provider: string): boolean {
  return provider === "anthropic";
}

// --- per-session registry ---------------------------------------------------

const warmers = new Map<string, CacheWarmer>();

export function getCacheWarmer(
  sessionId: string,
  deps: CacheWarmerDeps,
): CacheWarmer {
  let w = warmers.get(sessionId);
  if (!w) {
    w = new CacheWarmer(deps);
    warmers.set(sessionId, w);
  }
  return w;
}

export function disposeCacheWarmer(sessionId: string): void {
  warmers.get(sessionId)?.cancel();
  warmers.delete(sessionId);
}
