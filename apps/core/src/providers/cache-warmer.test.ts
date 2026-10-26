import test from "node:test";
import assert from "node:assert/strict";
import {
  CacheWarmer,
  decideWarm,
  warmingDelayMs,
  resolveCacheWarmingMode,
  MAX_IDLE_WARMING_AGE_MS,
  MIN_EXPECTED_SAVINGS_USD,
  type CacheWarmingMode,
  type WarmedReport,
} from "./cache-warmer.js";
import type { AIProvider, ExecuteOptions, ExecuteResult } from "./types.js";

// Sonnet-class rate card: $3 in, $15 out, 0.1x read, 1.25x write.
const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

test("delay is 90% of the TTL with a ten-second floor of margin", () => {
  assert.equal(warmingDelayMs(5 * 60_000), 270_000);
  assert.equal(warmingDelayMs(60 * 60_000), 54 * 60_000);
  assert.equal(warmingDelayMs(15_000), 5_000);
  assert.equal(warmingDelayMs(10_000), undefined);
});

test("economics: a large idle prompt is worth warming, a small one is not", () => {
  // 300K tokens idle: 0.15 * (3.75-0.3) * 0.3 = $0.155 expected miss cost
  // against a $0.09 refresh — worth it. (At Sonnet prices the idle
  // break-even is ~230K tokens; at Opus prices ~46K.)
  const big = decideWarm(price, 300_000, "idle");
  assert.equal(big.economicsAvailable, true);
  assert.ok(big.expectedSavingsUsd > MIN_EXPECTED_SAVINGS_USD);
  assert.equal(big.action, "warm");
  assert.ok(big.expectedSavingsUsd < 0.15 * big.missCostUsd);

  // 10K tokens idle: 0.15 * 0.0345 - 0.003 = ~$0.002 → stop.
  const small = decideWarm(price, 10_000, "idle");
  assert.equal(small.action, "stop");

  // Same 10K while the run is still active is certain to continue but still
  // under the $0.05 threshold.
  assert.equal(decideWarm(price, 10_000, "streaming").action, "stop");
  assert.equal(decideWarm(price, 40_000, "streaming").action, "warm");
});

test("economics: unknown price or empty prompt never warms", () => {
  assert.equal(
    decideWarm(undefined, 200_000, "idle").economicsAvailable,
    false,
  );
  assert.equal(decideWarm(undefined, 200_000, "idle").action, "stop");
  assert.equal(decideWarm(price, 0, "idle").action, "stop");
});

test("mode: env beats settings, unknown values fall back to off", () => {
  assert.equal(
    resolveCacheWarmingMode(undefined, { FREECODE_CACHE_WARMING: "idle" }),
    "idle",
  );
  assert.equal(
    resolveCacheWarmingMode(undefined, {
      FREECODE_CACHE_WARMING: "bogus",
      HOME: "/nonexistent",
    }),
    "off",
  );
});

// --- scheduling, with a fake clock and a fake provider -----------------------

function rig(mode: CacheWarmingMode = "idle", fail = false) {
  let now = 1_000_000;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let nextId = 1;
  const executed: ExecuteOptions[] = [];
  const warmed: WarmedReport[] = [];
  const stopped: string[] = [];
  const failed: WarmedReport[] = [];
  const provider: AIProvider = {
    info: {
      id: "anthropic",
      name: "a",
      defaultModel: "m",
      supportsStreaming: false,
      supportsTools: true,
    },
    execute: async (opts): Promise<ExecuteResult> => {
      executed.push(opts);
      if (fail) throw new Error("offline");
      return {
        content: "",
        stopReason: "max_tokens",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: {
          inputTokens: 150_000,
          outputTokens: 1,
          cacheReadInputTokens: 149_000,
        },
      };
    },
  };
  const warmer = new CacheWarmer({
    getProvider: () => provider,
    getMode: () => mode,
    getPrice: () => price,
    onWarmed: (r) => warmed.push(r),
    onFailed: (r) => failed.push({ ...r, usage: undefined }),
    onStopped: (r) => stopped.push(r),
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, at: now + ms, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  // Advance the clock and fire every timer that came due, in order.
  const advance = async (ms: number) => {
    const target = now + ms;
    while (true) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > target) break;
      timers.shift();
      now = t.at;
      t.fn();
      // Let the async refresh settle before the next timer.
      await new Promise((r) => setImmediate(r));
    }
    now = target;
  };
  const request = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    options: {
      messages: [],
      system: "s",
      model: "claude-sonnet-4-5",
      maxTokens: 8000,
    },
    promptTokens: 300_000,
  };
  return {
    warmer,
    advance,
    executed,
    warmed,
    failed,
    stopped,
    timers,
    request,
  };
}

test("replays the last request with a one-token cap at 90% of the TTL, then re-arms", async () => {
  const { warmer, advance, executed, warmed, request, timers } = rig("idle");
  warmer.start(request);
  assert.equal(warmer.status.state, "scheduled");
  assert.equal(timers.length, 1);
  warmer.onRunSettled();
  assert.equal(warmer.status.phase, "idle");

  await advance(270_000);
  assert.equal(executed.length, 1, "one replay at 4m30s");
  assert.equal(executed[0]!.maxTokens, 1);
  assert.equal(executed[0]!.system, "s");
  assert.equal(executed[0]!.stream, false);
  assert.equal(warmed.length, 1);
  assert.equal(warmed[0]!.phase, "idle");
  assert.equal(warmed[0]!.decision.action, "warm");
  assert.equal(
    warmer.status.state,
    "scheduled",
    "re-armed after a successful refresh",
  );

  await advance(270_000);
  assert.equal(executed.length, 2);
});

test("a new real request replaces the pending warm; cancel clears it", async () => {
  const { warmer, advance, executed, request, timers } = rig("idle");
  warmer.start(request);
  await advance(100_000);
  warmer.start({ ...request, promptTokens: 320_000 });
  assert.equal(timers.length, 1, "the earlier timer was cleared, not added to");
  await advance(200_000);
  assert.equal(executed.length, 0, "the replaced schedule did not fire");
  warmer.cancel();
  assert.equal(warmer.status.state, "inactive");
  await advance(600_000);
  assert.equal(executed.length, 0);
});

test("a failed refresh remains observable and re-arms", async () => {
  const { warmer, advance, failed, request } = rig("idle", true);
  warmer.start(request);
  warmer.onRunSettled();
  await advance(270_000);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.provider, "anthropic");
  assert.equal(warmer.status.state, "scheduled");
});

test("streaming mode stops when the run settles; idle mode stops at the 30-minute limit", async () => {
  const s = rig("streaming");
  s.warmer.start(s.request);
  s.warmer.onRunSettled();
  assert.equal(s.warmer.status.state, "inactive");
  assert.deepEqual(s.stopped, ["run settled"]);

  const i = rig("idle");
  i.warmer.start(i.request);
  i.warmer.onRunSettled();
  await i.advance(MAX_IDLE_WARMING_AGE_MS + 60_000);
  assert.ok(
    i.executed.length >= 5 && i.executed.length <= 7,
    `warmed ${i.executed.length} times in 30 min`,
  );
  assert.equal(i.warmer.status.state, "inactive");
  assert.ok(i.stopped.includes("30-minute idle limit reached"));
});

test("a prompt too small to be worth it stops without a request", async () => {
  const { warmer, advance, executed, stopped, request } = rig("idle");
  warmer.start({ ...request, promptTokens: 5_000 });
  await advance(300_000);
  assert.equal(executed.length, 0);
  assert.deepEqual(stopped, ["expected savings below threshold"]);
});

test("off mode never schedules; a non-Anthropic provider never schedules", () => {
  const off = rig("off");
  off.warmer.start(off.request);
  assert.equal(off.warmer.status.state, "inactive");
  const other = rig("idle");
  other.warmer.start({ ...other.request, provider: "openai" });
  assert.equal(other.warmer.status.state, "inactive");
});
