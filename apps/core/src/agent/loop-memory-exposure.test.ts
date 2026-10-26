// =============================================================================
// End-to-end: the loop writes one `memory.exposure` per provider request, with
// the bytes that request actually carried (spec 2026-09-25 §5 acceptance).
//
// A tool loop resends the memory block on every iteration, and each resend is
// paid for. The UI notice dedupes per user message; the cost accounting must
// not. Runs the real loop against a fake provider, with retrieval stubbed on
// the real graph service and HOME pointed at a temp dir so no real memory
// store is touched.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "freecode-exposure-home-"));
process.env.FREECODE_DISABLE_MEMORY_JUDGE = "1";
process.env.FREECODE_DISABLE_MEMORY_EXTRACTION = "1";

const { makeTestLayer } = await import("../effect/layers.js");
const { makeRuntime } = await import("../effect/runtime.js");
const { SessionStoreTag } = await import("../effect/context.js");
const { createAgentLoopEffect } = await import("./loop.js");
const { MemoryService } = await import("../compaction/service.js");
const { createRecorder } = await import("../rollout/recorder.js");
const { registerProvider } = await import("../providers/registry.js");
const { getMemoryGraphService } = await import("../memory/graph/index.js");
const { buildTrace } = await import("../rollout/trace.js");
import type { ProviderId } from "../providers/config.js";
import type { AIProvider, ExecuteResult } from "../providers/types.js";
import type { MemoryEntry } from "../memory/mem-types.js";
import type { RolloutEvent } from "../rollout/types.js";
import { newlyDelivered } from "./context-inject.js";

function info(id: string) {
  return {
    id,
    name: id,
    defaultModel: "fake-model",
    supportsStreaming: false,
    supportsTools: true,
  };
}

const MEMORY: MemoryEntry = {
  name: "uses-pnpm",
  type: "project",
  description: "package manager",
  content: "This repo uses pnpm, never npm.",
  createdAt: 0,
  updatedAt: 0,
};

// Always asks for a (bogus) tool, so only the iteration cap ends the run.
function toolLooper(id: string, tails: string[]) {
  registerProvider(id as ProviderId, {
    info: info(id),
    create: (): AIProvider => ({
      info: info(id),
      execute: async (opts): Promise<ExecuteResult> => {
        tails.push(newlyDelivered(opts));
        return {
          content: `step ${tails.length}`,
          toolCalls: [{ name: "does-not-exist", args: {}, id: `c${tails.length}` }],
          stopReason: "tool_use",
          provider: id,
          model: "fake-model",
          usage: { inputTokens: 100, outputTokens: 5 },
        };
      },
    }),
  });
}

async function run(
  sessionId: string,
  provider: string,
  retrieved: MemoryEntry[],
  iterations: number,
) {
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-exposure-rollout-"));
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-exposure-proj-"));
  const retrieveCalls = { n: 0 };
  (
    getMemoryGraphService(projectPath) as unknown as {
      retrieve: (q: string) => Promise<MemoryEntry[]>;
    }
  ).retrieve = async () => {
    retrieveCalls.n++;
    return retrieved;
  };

  const runtime = makeRuntime(
    makeTestLayer({
      memoryFactory: {
        forSession: () =>
          new MemoryService(sessionId, {
            storage: {
              save: () => {},
              load: () => undefined,
              listSessions: () => [],
              delete: () => {},
            } as never,
          }),
      },
      recorderFactory: {
        forSession: (id: string) => createRecorder(id, { rolloutDir }),
      },
    }),
  );
  try {
    const store = await runtime.runPromise(SessionStoreTag);
    await store.createSession({ title: "t", projectPath, provider }, sessionId);
    const loop = await runtime.runPromise(
      createAgentLoopEffect(sessionId, { maxIterations: iterations }),
    );
    await loop.run({ prompt: "install deps", sessionId, provider, projectPath });
    const file = join(rolloutDir, "events.jsonl");
    const events: RolloutEvent[] = existsSync(file)
      ? readFileSync(file, "utf-8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l))
      : [];
    return Object.assign(events, { retrieveCalls: retrieveCalls.n });
  } finally {
    await runtime.dispose();
    rmSync(rolloutDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  }
}

test("a tool loop records one exposure per request, injected where the block was delivered", async () => {
  const tails: string[] = [];
  toolLooper("exposure-fake", tails);
  const events = await run("exposure-loop", "exposure-fake", [MEMORY], 4);

  const exposures = events.filter((e) => e.type === "memory.exposure") as Array<
    Extract<RolloutEvent, { type: "memory.exposure" }>
  >;
  const requests = events.filter((e) => e.type === "model.request");
  assert.equal(requests.length, tails.length, "one request per provider call");
  assert.equal(exposures.length, requests.length, "one exposure per request");

  const carried = tails.filter((t) => t.includes("uses-pnpm")).length;
  // Append-only (the default): delivered once and kept in the conversation,
  // not resent on every request as the old tail did.
  assert.equal(carried, 1, `the block was delivered once (${carried} of ${tails.length})`);
  const injected = exposures.filter((e) => e.injected);
  assert.equal(injected.length, carried, "exposure counts the request that delivered it");
  for (const e of injected) {
    assert.ok(e.blockBytes > 0);
    assert.equal(e.renderedCount, 1);
    assert.equal(e.fullCount, 1);
    assert.equal(e.summaryCount, 0);
    // The loop omits the judge context when the setting is off.
    assert.equal(e.judgeDecision, "not_configured");
  }
  // The exposure event never carries memory text or identities.
  assert.ok(!JSON.stringify(exposures).includes("pnpm"));

  const trace = buildTrace("exposure-loop", events);
  assert.equal(trace.memoryExposures, carried);
  assert.equal(
    trace.memoryExposureBytes,
    injected.reduce((n, e) => n + e.blockBytes, 0),
  );
});

test("a request with no injected memory records zero block bytes", async () => {
  const tails: string[] = [];
  toolLooper("exposure-empty", tails);
  const events = await run("exposure-none", "exposure-empty", [], 2);
  const exposures = events.filter((e) => e.type === "memory.exposure") as Array<
    Extract<RolloutEvent, { type: "memory.exposure" }>
  >;
  assert.ok(exposures.length > 0);
  for (const e of exposures) {
    assert.equal(e.injected, false);
    assert.equal(e.blockBytes, 0);
    assert.equal(e.estimatedTokens, 0);
    assert.equal(e.renderedCount, 0);
  }
});

test("recall switched off: no retrieval, no block, and every request says why", async () => {
  // The "memory off" side of the paired eval (spec 2026-09-25 §6). `disabled`
  // keeps an off trial distinguishable from a store that had nothing to offer.
  const tails: string[] = [];
  toolLooper("exposure-off", tails);
  process.env.FREECODE_DISABLE_MEMORY_RECALL = "1";
  try {
    const events = await run("exposure-off", "exposure-off", [MEMORY], 3);
    assert.equal(events.retrieveCalls, 0, "retrieval never ran");
    assert.ok(tails.every((t) => !t.includes("uses-pnpm")), "no block was sent");
    const exposures = events.filter((e) => e.type === "memory.exposure") as Array<
      Extract<RolloutEvent, { type: "memory.exposure" }>
    >;
    assert.equal(exposures.length, tails.length);
    for (const e of exposures) {
      assert.equal(e.preparation, "disabled");
      assert.equal(e.judgeDecision, "disabled");
      assert.equal(e.injected, false);
    }
  } finally {
    delete process.env.FREECODE_DISABLE_MEMORY_RECALL;
  }
});
