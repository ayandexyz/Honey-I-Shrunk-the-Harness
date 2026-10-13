import test from "node:test";
import assert from "node:assert/strict";
import type { SerializedMessage } from "./store.js";
import { keepLastNUserTurns } from "./compact-apply.js";

function msg(role: SerializedMessage["role"], text: string): SerializedMessage {
  return {
    id: `${role}-${text}`,
    role,
    parts: [{ type: "text", content: text }],
    timestamp: 0,
  };
}

test("keepLastNUserTurns keeps the last N user turns and everything after", () => {
  const messages = [
    msg("user", "u1"),
    msg("assistant", "a1"),
    msg("user", "u2"),
    msg("assistant", "a2"),
    msg("user", "u3"),
    msg("assistant", "a3"),
  ];

  const kept = keepLastNUserTurns(messages, 2);
  assert.deepEqual(
    kept.map((m) => m.id),
    ["user-u2", "assistant-a2", "user-u3", "assistant-a3"],
  );
  // Still starts on a user turn → valid conversation.
  assert.equal(kept[0].role, "user");
});

test("keepLastNUserTurns keeps everything when fewer than N user turns", () => {
  const messages = [msg("user", "u1"), msg("assistant", "a1")];
  assert.deepEqual(keepLastNUserTurns(messages, 2), messages);
});

test("keepLastNUserTurns with n<=0 keeps nothing", () => {
  assert.deepEqual(keepLastNUserTurns([msg("user", "u1")], 0), []);
});

test("keepLastNUserTurns falls back to the last N assistant turns on a single-prompt history", () => {
  const messages = [
    msg("user", "prompt"),
    msg("assistant", "t1"),
    msg("assistant", "t2"),
    msg("assistant", "t3"),
    msg("assistant", "t4"),
  ];
  assert.deepEqual(
    keepLastNUserTurns(messages, 2).map((m) => m.id),
    ["user-prompt", "assistant-t3", "assistant-t4"],
  );
  // Nothing before the tail to drop → untouched.
  assert.equal(keepLastNUserTurns(messages.slice(0, 3), 2).length, 3);
});

test("compaction forgets which reads are in context, so the next read is real", async () => {
  // Long-task run 2026-10-12: 89 of 100 "unchanged — scroll up" stubs pointed
  // at a read that compaction had already summarised away.
  const { applyCompaction } = await import("./compact-apply.js");
  const { canDedup, getReadState } = await import("../tools/read-state.js");
  const shown = { mtimeMs: 1, size: 10, offset: 0, limit: 2000 };
  const run = async (summary: string | undefined) => {
    const sessionId = `compact-reads-${summary ?? "none"}`;
    getReadState(sessionId).set("/p/a.ts", { ...shown, inContext: true });
    await applyCompaction({
      memory: { compact: async () => ({ success: true, summary, tokenCountBefore: 9, tokenCountAfter: 1 }) } as never,
      store: { getMessages: async () => [], replaceMessages: async () => {} } as never,
      sessionId,
      projectPath: "/p",
    });
    return canDedup(getReadState(sessionId).get("/p/a.ts"), shown);
  };
  assert.equal(await run("summary"), false, "compacted: the stub would point at nothing");
  assert.equal(await run(undefined), true, "nothing compacted: the earlier read is still there");
});
