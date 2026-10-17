import test from "node:test";
import assert from "node:assert/strict";
import { endSession, resetEndedSessions } from "./end-session.js";
import { disposeSessionMemory } from "../memory/index.js";
import { resetExtractPolicy } from "../memory/extract-policy.js";
import { disposeOutputStore } from "../tools/output-store/index.js";
import { disposeReadState } from "../tools/read-state.js";
import { disposeCacheAwareness } from "../providers/cache-awareness.js";
import { disposeFrozenSessionContext } from "../context/session-context.js";
import { trackMemoryJob } from "../memory/background-jobs.js";

// The six disposers this exists to stop leaking. Named here so that adding a
// seventh per-session cache without wiring it into endSession is a test
// failure, not a leak nobody notices for a year.
const DISPOSERS = [
  disposeSessionMemory,
  resetExtractPolicy,
  disposeOutputStore,
  disposeReadState,
  disposeCacheAwareness,
  disposeFrozenSessionContext,
];

test("all six per-session disposers are callable for an unknown session", async () => {
  // They must be no-ops for a session that was never created — endSession runs
  // them unconditionally, including on paths where the session barely existed.
  resetEndedSessions();
  for (const dispose of DISPOSERS) {
    assert.doesNotThrow(() => dispose("never-existed"));
  }
  await endSession("never-existed-2", { reason: "delete" });
});

test("is idempotent per session id", async () => {
  resetEndedSessions();
  let flushes = 0;
  const flush = async () => {
    flushes++;
  };

  await endSession("s1", { reason: "switch", flush });
  await endSession("s1", { reason: "switch", flush });
  await endSession("s1", { reason: "exit", flush });

  assert.equal(flushes, 1, "switching away and back must not flush twice");
});

test("different sessions each end once", async () => {
  resetEndedSessions();
  const ended: string[] = [];
  await endSession("a", { reason: "switch", flush: async () => void ended.push("a") });
  await endSession("b", { reason: "switch", flush: async () => void ended.push("b") });
  assert.deepEqual(ended, ["a", "b"]);
});

test("omitting flush runs the disposers and nothing else", async () => {
  resetEndedSessions();
  // The `delete` path: the user discarded the session, so it must not be mined.
  let flushed = false;
  await endSession("deleted", {
    reason: "delete",
    flush: undefined,
    also: () => {
      flushed = false;
    },
  });
  assert.equal(flushed, false);
});

test("the caller's extra cleanup runs too", async () => {
  resetEndedSessions();
  let alsoRan = false;
  await endSession("s2", { reason: "archive", also: () => (alsoRan = true) });
  assert.equal(alsoRan, true, "message queue cleanup must not be forgotten");
});

test("a throwing flush never rejects out of endSession", async () => {
  resetEndedSessions();
  await assert.doesNotReject(
    endSession("s3", {
      reason: "exit",
      flush: async () => {
        throw new Error("provider is down");
      },
    }),
  );
});

test("a throwing extra-cleanup does not strand the rest", async () => {
  resetEndedSessions();
  // `also` runs after the disposers, so a throw here cannot leak a cache — but
  // it must still not escape and break the user action that ended the session.
  await assert.rejects(
    endSession("s4", {
      reason: "archive",
      also: () => {
        throw new Error("queue delete failed");
      },
    }),
  );
});

test("exit waits for the flush; other reasons do not", async () => {
  resetEndedSessions();
  let landed = false;
  const slowFlush = async () => {
    await new Promise((r) => setTimeout(r, 20));
    landed = true;
  };

  await endSession("switching", { reason: "switch", flush: slowFlush });
  assert.equal(landed, false, "switch is fire-and-forget");

  await endSession("exiting", { reason: "exit", flush: slowFlush });
  assert.equal(landed, true, "exit waits, because the process is leaving");
});

test("exit drains existing memory work and the final flush under one budget", async () => {
  resetEndedSessions();
  const completed: string[] = [];
  void trackMemoryJob(
    "drained",
    new Promise<void>((resolve) =>
      setTimeout(() => {
        completed.push("background");
        resolve();
      }, 10),
    ),
  );

  const result = await endSession("drained", {
    reason: "exit",
    memoryDrainTimeoutMs: 100,
    flush: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      completed.push("flush");
    },
  });

  assert.deepEqual(completed.sort(), ["background", "flush"]);
  assert.deepEqual(result, {
    pendingMemoryJobs: 0,
    memoryDrainTimedOut: false,
  });
});

test("exit reports memory work that outlives its drain budget", async () => {
  resetEndedSessions();
  const slow = new Promise<void>((resolve) => setTimeout(resolve, 50));
  void trackMemoryJob("timed-out", slow);

  const startedAt = Date.now();
  const result = await endSession("timed-out", {
    reason: "exit",
    memoryDrainTimeoutMs: 5,
    flush: () => slow,
  });

  assert.equal(result.memoryDrainTimedOut, true);
  assert.ok(result.pendingMemoryJobs >= 1);
  assert.ok(Date.now() - startedAt < 40, "the configured budget bounds exit");
  await slow;
});
