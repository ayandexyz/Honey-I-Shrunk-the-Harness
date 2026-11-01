import assert from "node:assert/strict";
import test from "node:test";
import {
  bumpCacheGeneration,
  checkCacheUsage,
  describeCacheProblem,
  getCacheStats,
  isCacheMissNoticesEnabled,
  resetCacheTracking,
} from "./cache-miss.js";
import { recordInvalidation } from "./cache-invalidation.js";

let seq = 0;
/** A fresh session id per test — the detector keys its state by session. */
function session(): string {
  return `s-${++seq}`;
}

const warm = (read: number, write = 0, input = 100) => ({
  cacheReadTokens: read,
  cacheWriteTokens: write,
  inputTokens: input,
});

test("the first call of a session is never a problem", () => {
  const s = session();
  assert.equal(checkCacheUsage(s, warm(0, 5_000)), undefined);
});

test("a growing prefix is silent", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 10_000)); // first turn writes the prefix
  assert.equal(checkCacheUsage(s, warm(10_000, 500)), undefined);
  assert.equal(checkCacheUsage(s, warm(10_500, 400)), undefined);
});

test("reading nothing after a cached prefix is a miss — reported one sample late", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 10_000));

  // The miss itself is held: it could still be a provider blip.
  assert.equal(checkCacheUsage(s, warm(0, 10_000)), undefined);
  // The follow-up read never recovers to the 10k bar — now it alarms.
  const problem = checkCacheUsage(s, warm(0, 10_000));
  assert.equal(problem?.kind, "expected_read_missing");
  assert.equal(problem?.affectedTokens, 10_000);
  assert.equal(problem?.documentedCause, undefined);
});

test("reading less than was cached means the prefix was re-written", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 10_000));

  // Only 6k of the known 10k prefix survived — 4k was re-sent at full price.
  assert.equal(checkCacheUsage(s, warm(6_000, 4_000)), undefined); // held
  const problem = checkCacheUsage(s, warm(6_000, 4_500)); // still below 10k
  assert.equal(problem?.kind, "unexpected_creation");
  assert.equal(problem?.affectedTokens, 4_000);
});

test("a miss the next read recovers from is a provider blip, not a rewrite", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 22_000));
  // The MiniMax-M3 signature: read collapses to a sliver…
  assert.equal(checkCacheUsage(s, warm(128, 5_000)), undefined);
  // …and the NEXT read resumes at the pre-miss boundary — only possible if
  // the prefix bytes never changed. No alarm, then or later.
  assert.equal(checkCacheUsage(s, warm(22_600, 400)), undefined);
  assert.equal(checkCacheUsage(s, warm(23_000, 300)), undefined);
});

test("a documented invalidation explains the miss instead of alarming", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 10_000));
  recordInvalidation(s, "compaction", "auto compaction: 190000 → 40000 tokens");

  const problem = checkCacheUsage(s, warm(0, 4_000));
  assert.equal(problem?.kind, "expected_read_missing");
  assert.match(problem!.documentedCause!, /compaction/);
});

test("a generation bump suppresses the rebuild compaction must cause", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 10_000));
  bumpCacheGeneration(s);

  // The post-compaction turn reads nothing, which is expected, not a bust.
  assert.equal(checkCacheUsage(s, warm(0, 4_000)), undefined);
});

test("a provider that reports no cache activity is never flagged", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 10_000));
  // Gemini/OpenAI-shaped: no cache fields at all. Absent data must not look
  // like a miss, and must not leave a zero baseline behind either.
  assert.equal(checkCacheUsage(s, warm(0, 0)), undefined);
  assert.equal(checkCacheUsage(s, warm(0, 8_000)), undefined);
});

test("an old journal entry does not excuse a later bust", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 10_000));
  recordInvalidation(s, "compaction", "long ago");

  // Two minutes later, outside the attribution window. Undocumented, so it is
  // held one sample, then reported without a cause.
  const later = Date.now() + 120_000;
  assert.equal(checkCacheUsage(s, warm(0, 4_000), later), undefined);
  const problem = checkCacheUsage(s, warm(0, 4_000), later);
  assert.ok(problem);
  assert.equal(problem?.documentedCause, undefined);
});

test("resetCacheTracking forgets the session", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 10_000));
  resetCacheTracking(s);
  assert.equal(checkCacheUsage(s, warm(0, 10_000)), undefined);
});

test("the notice names the tokens and points at the likely cause", () => {
  const text = describeCacheProblem({
    kind: "unexpected_creation",
    affectedTokens: 12_345,
  });
  assert.match(text, /12,345 tokens/);
  assert.match(text, /already-sent message/);
});

test("FREECODE_CACHE_MISS_NOTICES=0 turns the alarm off", () => {
  const original = process.env.FREECODE_CACHE_MISS_NOTICES;
  try {
    delete process.env.FREECODE_CACHE_MISS_NOTICES;
    assert.equal(isCacheMissNoticesEnabled(), true);
    process.env.FREECODE_CACHE_MISS_NOTICES = "0";
    assert.equal(isCacheMissNoticesEnabled(), false);
  } finally {
    if (original === undefined) delete process.env.FREECODE_CACHE_MISS_NOTICES;
    else process.env.FREECODE_CACHE_MISS_NOTICES = original;
  }
});

// --- yield accounting + miss attribution (jcode's KV cache widget) ---------

test("no stats before a provider has reported cache fields", () => {
  const s = session();
  assert.equal(getCacheStats(s), undefined);
  checkCacheUsage(s, warm(0, 0, 5_000));
  assert.equal(getCacheStats(s), undefined);
});

test("yield is read over what the previous prompt made cacheable", () => {
  const s = session();
  // Prompt 10k, all written. Nothing to yield against yet.
  checkCacheUsage(s, warm(0, 10_000, 10_000));
  let stats = getCacheStats(s)!;
  assert.equal(stats.yieldPct, undefined);
  assert.equal(stats.lastPct, 0);
  assert.equal(stats.sessionPct, 0);

  // Next prompt 12k: 10k read, 2k written. Yield = 10k / 10k = 100%,
  // last = 10k / 12k = 83%.
  checkCacheUsage(s, warm(10_000, 2_000, 12_000));
  stats = getCacheStats(s)!;
  assert.equal(stats.yieldPct, 100);
  assert.equal(stats.lastYieldPct, 100);
  assert.equal(stats.lastPct, 83);
  assert.equal(stats.sessionPct, Math.round((10_000 / 22_000) * 100));
  assert.deepEqual(stats.misses, []);
});

test("a rewrite lowers yield and lands in the attribution list, one sample late", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 10_000, 10_000));
  checkCacheUsage(s, {
    ...warm(6_000, 4_000, 10_000),
    turn: { run: 2, call: 1 },
  });
  // Held: still no sample.
  assert.equal(getCacheStats(s)!.misses.length, 0);
  assert.equal(getCacheStats(s)!.lastYieldPct, 60);
  checkCacheUsage(s, warm(6_000, 4_500, 10_500));
  const [miss] = getCacheStats(s)!.misses;
  assert.deepEqual(miss, {
    turn: { run: 2, call: 1 },
    missedTokens: 4_000,
    reason: "harness: prefix rewritten",
    harnessBug: true,
  });
});

test("an acquitted blip is listed as the provider's, not alarmed", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 22_000, 22_000));
  assert.equal(checkCacheUsage(s, warm(128, 5_000, 22_100)), undefined);
  assert.equal(checkCacheUsage(s, warm(22_600, 400, 23_000)), undefined);
  const [miss] = getCacheStats(s)!.misses;
  assert.equal(miss.reason, "provider blip");
  assert.equal(miss.harnessBug, false);
});

test("a model switch is attributed, never alarmed, and never held", () => {
  const s = session();
  const on = (model: string) => ({ provider: "anthropic", model });
  checkCacheUsage(s, { ...warm(0, 10_000, 10_000), ...on("a") });
  assert.equal(
    checkCacheUsage(s, { ...warm(0, 10_000, 10_000), ...on("b") }),
    undefined,
  );
  // No pending: the follow-up is judged on its own, and it is clean.
  assert.equal(
    checkCacheUsage(s, { ...warm(10_000, 500, 10_500), ...on("b") }),
    undefined,
  );
  const { misses } = getCacheStats(s)!;
  assert.equal(misses.length, 1);
  assert.equal(misses[0].reason, "model switch");
  assert.equal(misses[0].harnessBug, false);
});

test("a gap past the Anthropic TTL is attributed as expired", () => {
  // This gap (6 min) is written against the 5m TTL; getCacheTtl() defaults
  // to 1h (utils.ts), so pin it explicitly rather than rely on the ambient
  // default.
  const prevCacheTtl = process.env.FREECODE_CACHE_TTL;
  process.env.FREECODE_CACHE_TTL = "5m";
  try {
    const s = session();
    const on = { provider: "anthropic", model: "m" };
    const t0 = Date.now();
    checkCacheUsage(s, { ...warm(0, 10_000, 10_000), ...on }, t0);
    const later = t0 + 6 * 60_000;
    assert.equal(
      checkCacheUsage(s, { ...warm(0, 10_000, 10_000), ...on }, later),
      undefined,
    );
    assert.equal(getCacheStats(s)!.misses[0].reason, "expired");
  } finally {
    if (prevCacheTtl === undefined) delete process.env.FREECODE_CACHE_TTL;
    else process.env.FREECODE_CACHE_TTL = prevCacheTtl;
  }
});

test("a documented miss is attributed to its journal entry", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 10_000, 10_000));
  recordInvalidation(s, "compaction", "auto compaction: 190000 → 40000 tokens");
  checkCacheUsage(s, warm(0, 4_000, 4_000));
  const [miss] = getCacheStats(s)!.misses;
  assert.match(miss.reason, /^compaction: /);
  assert.equal(miss.harnessBug, false);
});

test("a shortfall under 1k tokens is rounding, not a miss", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 10_000, 10_000));
  assert.equal(checkCacheUsage(s, warm(9_500, 600, 10_100)), undefined);
  assert.equal(checkCacheUsage(s, warm(9_500, 700, 10_200)), undefined);
  assert.equal(getCacheStats(s)!.misses.length, 0);
});

test("compaction does not count against yield", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 100_000, 100_000));
  bumpCacheGeneration(s);
  // Rebuilt history: a fresh 20k prompt. Not held to the 100k prompt.
  checkCacheUsage(s, warm(0, 20_000, 20_000));
  assert.equal(getCacheStats(s)!.yieldPct, undefined);
  checkCacheUsage(s, warm(20_000, 1_000, 21_000));
  assert.equal(getCacheStats(s)!.yieldPct, 100);
});

test("resetCacheTracking drops the stats too", () => {
  const s = session();
  checkCacheUsage(s, warm(0, 10_000, 10_000));
  resetCacheTracking(s);
  assert.equal(getCacheStats(s), undefined);
});
