import test from "node:test";
import assert from "node:assert/strict";
import type { SerializedMessage } from "./store.js";
import { keepRecentTokens } from "./compact-tail.js";
import { estimateMessageTokens } from "../compaction/tokens.js";

// ~250 tokens of tool output per message.
const OUTPUT = "x".repeat(1_000);
let seq = 0;

function user(text: string, synthetic?: SerializedMessage["synthetic"]): SerializedMessage {
  return { id: `u${seq++}`, role: "user", parts: [{ type: "text", content: text }], timestamp: seq, ...(synthetic ? { synthetic } : {}) };
}
function toolCall(): SerializedMessage {
  return {
    id: `a${seq++}`,
    role: "assistant",
    parts: [{ type: "tool", tool: { name: "bash", args: { command: "grep -rn x" } }, result: OUTPUT }],
    timestamp: seq,
  };
}
function screenshot(): SerializedMessage {
  return {
    id: `i${seq++}`,
    role: "user",
    parts: [{ type: "text", content: "Image from the tool call above:" }, { type: "image", data: "AAAA", mediaType: "image/png" }],
    timestamp: seq,
    synthetic: "tool_image",
  };
}
const ids = (messages: SerializedMessage[]) => messages.map((m) => m.id);

test("one long turn shrinks to the budget and keeps its prompt (session ff9dd627)", () => {
  const prompt = user("add @ file mentions to the desktop app");
  const messages = [prompt];
  for (let i = 0; i < 300; i++) {
    messages.push(toolCall());
    if (i === 290 || i === 295) messages.push(screenshot());
  }
  const kept = keepRecentTokens(messages, 5_000);
  assert.equal(kept[0], prompt, "the brief survives a mid-turn cut");
  assert.ok(kept.length < 30, `kept ${kept.length} of ${messages.length}`);
  assert.equal(kept[1].role, "assistant");
});

test("never starts the tail on appended context or a tool image", () => {
  const prompt = user("task");
  const messages = [prompt, toolCall(), toolCall(), screenshot(), user("memory", "context"), toolCall()];
  // The budget is reached inside the context message and the screenshot; the
  // nearest cut point after them is the last tool call.
  const kept = keepRecentTokens(messages, 1);
  assert.deepEqual(ids(kept), [prompt.id, messages[5].id]);
});

test("a cut on a turn start keeps no extra prompt", () => {
  const messages = [user("first"), toolCall(), toolCall(), user("second"), toolCall()];
  // The budget is reached exactly at "second": last call + "second".
  const budget = estimateMessageTokens(messages[4]) + estimateMessageTokens(messages[3]);
  const kept = keepRecentTokens(messages, budget);
  assert.deepEqual(ids(kept), ids(messages.slice(3)));
});

test("a prompt bigger than the whole budget is not pinned", () => {
  const doc = user("y".repeat(40_000)); // ~10K tokens: a pasted document
  const messages = [doc, toolCall(), toolCall(), toolCall(), toolCall()];
  const kept = keepRecentTokens(messages, 600);
  assert.ok(!kept.includes(doc));
  assert.ok(kept.length < messages.length);
});

test("keeps at most half the conversation when the cap would hold all of it", () => {
  // Eval cases trigger at 12K with ~9.5K of system prompt and tools, so the
  // conversation is ~3K: a 20K tail would keep everything and drop nothing.
  const messages = [user("task"), toolCall(), toolCall(), toolCall(), toolCall()];
  const kept = keepRecentTokens(messages, 20_000);
  assert.ok(kept.length < messages.length, `kept ${kept.length} of ${messages.length}`);
  assert.equal(kept[0], messages[0], "the turn's prompt is still pinned");
});
