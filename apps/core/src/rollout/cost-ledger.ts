// =============================================================================
// Task cost ledger — one body-free row per provider attempt across a root
// session and every recorded child session.
// =============================================================================

import { priceUsd, pricesAsOf } from "../providers/pricing.js";
import { loadSessionEvents } from "./history.js";
import { HANG_THRESHOLD_MS } from "./trace.js";
import type {
  CacheWarmEvent,
  MemoryAuxiliaryEvent,
  ModelErrorEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  RolloutEvent,
} from "./types.js";

export type ProviderAttemptPurpose =
  | "agent"
  | "subagent"
  | "verifier"
  | "retrieval_judge"
  | "extraction"
  | "consolidation"
  | "compaction"
  | "redirection"
  | "hook"
  | "final_flush"
  | "cache_warm"
  | "grader";

export type AttemptCompletion = "succeeded" | "failed" | "in_flight" | "hung";

export interface ProviderAttemptUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface ProviderAttemptLedgerEntry {
  id: string;
  rootSessionId: string;
  sessionId: string;
  parentSessionId?: string;
  purpose: ProviderAttemptPurpose;
  provider: string;
  /** Resolved request model, never the current config value. */
  model?: string;
  echoedModel?: string;
  authMode: "oauth" | "api-key";
  /** "1h" when this attempt's cache writes billed at the 2x extended-TTL rate. */
  cacheTtl?: "1h";
  /**
   * Vintage of the price source used **at fold time**. A ledger re-prices from
   * the recorded model/usage/authMode; it is not a receipt, so editing
   * `~/.freecode/pricing.json` (or refreshing the models.dev cache) changes
   * these totals for an old session.
   */
  pricingVintage: string;
  startedAt: number;
  duration_ms?: number;
  completion: AttemptCompletion;
  usageStatus: "complete" | "partial" | "unknown";
  usage: ProviderAttemptUsage;
  /** Undefined means unpriced or usage-unknown, never free. */
  costUsd?: number;
}

export interface CostLedgerSummary {
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd?: number;
  /** True when at least one attempt could not be priced completely. */
  partial: boolean;
}

export interface TaskCostLedger {
  rootSessionId: string;
  pricingVintage: string;
  runtimeAttempts: ProviderAttemptLedgerEntry[];
  /** Kept structurally separate so benchmark grading never inflates runtime. */
  graderAttempts: ProviderAttemptLedgerEntry[];
  runtime: CostLedgerSummary;
  grader: CostLedgerSummary;
  byPurpose: Partial<Record<ProviderAttemptPurpose, CostLedgerSummary>>;
  missingChildSessionIds: string[];
}

interface SessionRelation {
  parentSessionId?: string;
  agentType?: string;
}

function usageStatus(
  usage: ProviderAttemptUsage,
): ProviderAttemptLedgerEntry["usageStatus"] {
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) {
    return "unknown";
  }
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return "partial";
  }
  return "complete";
}

function pricedEntry(
  entry: Omit<ProviderAttemptLedgerEntry, "usageStatus" | "costUsd">,
): ProviderAttemptLedgerEntry {
  const status = usageStatus(entry.usage);
  const costUsd =
    entry.model && status === "complete"
      ? priceUsd(entry.provider, entry.model, entry.usage, entry.authMode)
      : undefined;
  return {
    ...entry,
    usageStatus: status,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function summarize(attempts: ProviderAttemptLedgerEntry[]): CostLedgerSummary {
  let priced = 0;
  let usd = 0;
  for (const attempt of attempts) {
    if (attempt.costUsd === undefined) continue;
    priced += 1;
    usd += attempt.costUsd;
  }
  return {
    attempts: attempts.length,
    inputTokens: attempts.reduce(
      (sum, attempt) => sum + (attempt.usage.inputTokens ?? 0),
      0,
    ),
    outputTokens: attempts.reduce(
      (sum, attempt) => sum + (attempt.usage.outputTokens ?? 0),
      0,
    ),
    cacheReadTokens: attempts.reduce(
      (sum, attempt) => sum + (attempt.usage.cacheReadTokens ?? 0),
      0,
    ),
    cacheWriteTokens: attempts.reduce(
      (sum, attempt) => sum + (attempt.usage.cacheWriteTokens ?? 0),
      0,
    ),
    ...(priced === 0 ? {} : { usd }),
    partial: priced < attempts.length,
  };
}

function foregroundPurpose(relation: SessionRelation): ProviderAttemptPurpose {
  if (!relation.parentSessionId) return "agent";
  return relation.agentType === "verifier" ? "verifier" : "subagent";
}

function foldSession(
  rootSessionId: string,
  sessionId: string,
  relation: SessionRelation,
  events: RolloutEvent[],
  vintage: string,
  asOf: number,
): ProviderAttemptLedgerEntry[] {
  const attempts: ProviderAttemptLedgerEntry[] = [];
  /** `turnId`/`requestId` are pairing keys, stripped before the ledger returns. */
  type OpenAttempt = ProviderAttemptLedgerEntry & {
    turnId?: string;
    requestId?: string;
  };
  const open: OpenAttempt[] = [];

  // A turn holds one attempt per recovery retry, so the terminator's own
  // request id is checked first; a turn match (or the single remaining open
  // attempt) keeps older logs, which predate `requestId`, pairing as before.
  const pairOpen = (terminator: {
    turnId: string;
    requestId?: string;
  }): OpenAttempt | undefined =>
    (terminator.requestId !== undefined
      ? open.find((attempt) => attempt.requestId === terminator.requestId)
      : undefined) ??
    open.find((attempt) => attempt.turnId === terminator.turnId) ??
    open[0];

  for (const event of events) {
    if (event.type === "model.request") {
      const request = event as ModelRequestEvent;
      const entry = pricedEntry({
        id: `${sessionId}:${request.id}:${request.turnId}`,
        rootSessionId,
        sessionId,
        ...(relation.parentSessionId
          ? { parentSessionId: relation.parentSessionId }
          : {}),
        purpose: foregroundPurpose(relation),
        provider: request.provider,
        model: request.model,
        authMode: request.authMode ?? "api-key",
        pricingVintage: vintage,
        startedAt: request.timestamp,
        completion: "in_flight",
        usage: {},
      }) as OpenAttempt;
      entry.turnId = request.turnId;
      entry.requestId = request.id;
      attempts.push(entry);
      open.push(entry);
      continue;
    }

    if (event.type === "model.response") {
      const response = event as ModelResponseEvent;
      const entry = pairOpen(response);
      if (!entry) continue;
      open.splice(open.indexOf(entry), 1);
      entry.provider = response.provider;
      entry.model = response.model;
      entry.echoedModel = response.echoedModel;
      entry.authMode = response.authMode ?? "api-key";
      entry.cacheTtl = response.cacheTtl;
      entry.duration_ms = response.duration_ms;
      entry.completion = "succeeded";
      entry.usage = {
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        cacheReadTokens: response.cacheReadTokens,
        cacheWriteTokens: response.cacheWriteTokens,
        reasoningTokens: response.reasoningTokens,
      };
      entry.usageStatus = usageStatus(entry.usage);
      entry.costUsd =
        entry.model && entry.usageStatus === "complete"
          ? priceUsd(
              entry.provider,
              entry.model,
              entry.usage,
              entry.authMode,
              entry.cacheTtl,
            )
          : undefined;
      continue;
    }

    if (event.type === "model.error") {
      const error = event as ModelErrorEvent;
      const entry = pairOpen(error);
      if (!entry) continue;
      open.splice(open.indexOf(entry), 1);
      entry.provider = error.provider;
      entry.model = error.model;
      entry.duration_ms = error.duration_ms;
      entry.completion = "failed";
      continue;
    }

    if (event.type === "memory.auxiliary") {
      const auxiliary = event as MemoryAuxiliaryEvent;
      attempts.push(
        pricedEntry({
          id: `${sessionId}:${auxiliary.id}`,
          rootSessionId,
          sessionId,
          ...(relation.parentSessionId
            ? { parentSessionId: relation.parentSessionId }
            : {}),
          purpose: auxiliary.purpose,
          provider: auxiliary.provider,
          model: auxiliary.model,
          authMode: auxiliary.authMode ?? "api-key",
          pricingVintage: vintage,
          startedAt: Math.max(0, auxiliary.timestamp - auxiliary.duration_ms),
          duration_ms: auxiliary.duration_ms,
          completion:
            auxiliary.outcome === "succeeded" ? "succeeded" : "failed",
          usage: {
            inputTokens: auxiliary.inputTokens,
            outputTokens: auxiliary.outputTokens,
            cacheReadTokens: auxiliary.cacheReadTokens,
            cacheWriteTokens: auxiliary.cacheWriteTokens,
            reasoningTokens: auxiliary.reasoningTokens,
          },
        }),
      );
      continue;
    }

    if (event.type === "cache.warm") {
      const warm = event as CacheWarmEvent;
      attempts.push(
        pricedEntry({
          id: `${sessionId}:${warm.id}`,
          rootSessionId,
          sessionId,
          ...(relation.parentSessionId
            ? { parentSessionId: relation.parentSessionId }
            : {}),
          purpose: "cache_warm",
          provider: warm.provider,
          model: warm.model,
          authMode: warm.authMode ?? "api-key",
          pricingVintage: vintage,
          startedAt: warm.timestamp,
          completion: warm.outcome === "failed" ? "failed" : "succeeded",
          usage: {
            inputTokens: warm.inputTokens,
            outputTokens: warm.outputTokens,
            cacheReadTokens: warm.cacheReadTokens,
            cacheWriteTokens: warm.cacheWriteTokens,
          },
        }),
      );
    }
  }

  for (const entry of open) {
    const duration = Math.max(0, asOf - entry.startedAt);
    entry.duration_ms = duration;
    entry.completion = duration >= HANG_THRESHOLD_MS ? "hung" : "in_flight";
  }
  // turnId/requestId are pairing-only and deliberately absent from the public
  // ledger.
  for (const entry of attempts as OpenAttempt[]) {
    delete entry.turnId;
    delete entry.requestId;
  }
  return attempts;
}

/** Pure fold used by tests, evals, and the disk-loading wrapper below. */
export function buildTaskCostLedger(
  rootSessionId: string,
  sessions: ReadonlyMap<string, RolloutEvent[]>,
  options: {
    now?: number;
    graderAttempts?: ProviderAttemptLedgerEntry[];
  } = {},
): TaskCostLedger {
  const vintage = pricesAsOf();
  const runtimeAttempts: ProviderAttemptLedgerEntry[] = [];
  const graderAttempts = options.graderAttempts ?? [];
  const missingChildSessionIds: string[] = [];
  const visited = new Set<string>();
  const queue: Array<{ sessionId: string; relation: SessionRelation }> = [
    { sessionId: rootSessionId, relation: {} },
  ];

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (visited.has(next.sessionId)) continue;
    visited.add(next.sessionId);
    const events = sessions.get(next.sessionId);
    if (!events) {
      if (next.sessionId !== rootSessionId) {
        missingChildSessionIds.push(next.sessionId);
      }
      continue;
    }
    const asOf =
      options.now ?? events[events.length - 1]?.timestamp ?? Date.now();
    runtimeAttempts.push(
      ...foldSession(
        rootSessionId,
        next.sessionId,
        next.relation,
        events,
        vintage,
        asOf,
      ),
    );
    for (const event of events) {
      if (event.type !== "subagent.start") continue;
      queue.push({
        sessionId: event.subagentId,
        relation: {
          parentSessionId: next.sessionId,
          agentType: event.agentType,
        },
      });
    }
  }

  const byPurpose: TaskCostLedger["byPurpose"] = {};
  for (const purpose of new Set(
    runtimeAttempts.map((entry) => entry.purpose),
  )) {
    byPurpose[purpose] = summarize(
      runtimeAttempts.filter((entry) => entry.purpose === purpose),
    );
  }
  return {
    rootSessionId,
    pricingVintage: vintage,
    runtimeAttempts,
    graderAttempts,
    runtime: summarize(runtimeAttempts),
    grader: summarize(graderAttempts),
    byPurpose,
    missingChildSessionIds,
  };
}

/** Load the complete recorded child tree, then run the pure ledger fold. */
export function loadTaskCostLedger(
  rootSessionId: string,
  options: { now?: number } = {},
): TaskCostLedger {
  const sessions = new Map<string, RolloutEvent[]>();
  const queued = [rootSessionId];
  const seen = new Set<string>();
  while (queued.length > 0) {
    const sessionId = queued.shift()!;
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    const loaded = loadSessionEvents(sessionId);
    if (!loaded) continue;
    sessions.set(sessionId, loaded.events);
    for (const event of loaded.events) {
      if (event.type === "subagent.start") queued.push(event.subagentId);
    }
  }
  return buildTaskCostLedger(rootSessionId, sessions, options);
}
