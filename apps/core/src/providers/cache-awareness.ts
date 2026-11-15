// =============================================================================
// Prompt-cache awareness (jcode #9). Anthropic's prompt cache defaults to a
// ~5-minute TTL (1h under FREECODE_CACHE_TTL — see providers/utils.ts): if more
// than that elapses between turns, the next request re-reads the
// full context as fresh input (cache MISS) — real money on long contexts. We
// track the last send per session and warn before a send that will miss, and
// surface hit/write token numbers after (see loop wiring + `cache_status` event).
//
// Pure bookkeeping, no provider calls. Non-caching providers are ignored.
// =============================================================================

import { getCacheTtl, type CacheTtl } from "./utils.js";
import { resolveCatalogue } from "./catalogue.js";

// The cold line follows whatever TTL the request actually asked for, so the
// warning stays true under FREECODE_CACHE_TTL=1h instead of firing at six
// minutes on an entry with another fifty-four to live.
const TTL_MS: Record<CacheTtl, number> = {
  "5m": 5 * 60 * 1000,
  "1h": 60 * 60 * 1000,
};

// Providers whose prompt cache is time-limited (so a gap causes a miss): every
// one the generic driver talks to through `@ai-sdk/anthropic`, which is the
// same test it uses to place the `cacheControl` markers (generic-provider.ts).
// That covers minimax and zai, which a hand-kept `["anthropic"]` list left out.
// OpenAI/Gemini caching is either automatic-without-TTL-signal or absent here.
function hasTimeLimitedCache(provider: string): boolean {
  return resolveCatalogue().some(
    (entry) => entry.id === provider && entry.npm === "@ai-sdk/anthropic",
  );
}

const lastSend = new Map<string, number>(); // sessionId → last send epoch ms

// Record a send and return a warning if this send will likely miss a cold cache.
// First send of a session returns null (nothing was cached yet — no miss).
export function noteSendAndCheckCold(
  sessionId: string,
  provider: string,
  now: number = Date.now(),
): string | null {
  if (!hasTimeLimitedCache(provider)) {
    lastSend.set(sessionId, now);
    return null;
  }
  const prev = lastSend.get(sessionId);
  lastSend.set(sessionId, now);
  if (prev === undefined) return null;
  const elapsed = now - prev;
  const ttl = getCacheTtl();
  if (elapsed <= TTL_MS[ttl]) return null;
  const mins = Math.round(elapsed / 60_000);
  const hint =
    ttl === "5m"
      ? " Set FREECODE_CACHE_TTL=1h if gaps like this are normal for you."
      : "";
  return `Prompt cache likely cold (~${mins} min since last turn > ${ttl} TTL) — this request re-reads the full context as fresh input and will cost more.${hint}`;
}

export interface CacheSummary {
  readTokens: number; // served from cache (cheap)
  writeTokens: number; // written to cache this turn (cache-creation)
}

export function summarizeCache(usage?: {
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): CacheSummary {
  // A hit ratio used to be computed here as read / (read + inputTokens) — wrong,
  // because `inputTokens` already includes cache reads and writes, and read by
  // nothing. The ratios the TUI shows come from `cache-miss.ts` (`getCacheStats`).
  return {
    readTokens: usage?.cacheReadInputTokens ?? 0,
    writeTokens: usage?.cacheCreationInputTokens ?? 0,
  };
}

export function disposeCacheAwareness(sessionId: string): void {
  lastSend.delete(sessionId);
}
