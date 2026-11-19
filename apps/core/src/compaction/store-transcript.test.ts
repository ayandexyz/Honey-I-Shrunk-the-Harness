import test from "node:test";
import assert from "node:assert/strict";
import type { SerializedMessage } from "../session/store.js";
import { storeToMemoryMessages } from "./store-transcript.js";

test("renders tool calls as transcript lines and images as a placeholder", () => {
  const messages: SerializedMessage[] = [
    { id: "u", role: "user", parts: [{ type: "text", content: "fix the bug" }], timestamp: 1 },
    {
      id: "a",
      role: "assistant",
      parts: [
        { type: "text", content: "Reading it." },
        { type: "tool", tool: { name: "grep", args: { pattern: "bug" } }, result: "src/a.ts:14: bug" },
      ],
      timestamp: 2,
    },
    {
      id: "i",
      role: "user",
      parts: [{ type: "text", content: "Image from the tool call above:" }, { type: "image", data: "AAAA", mediaType: "image/png" }],
      timestamp: 3,
      synthetic: "tool_image",
    },
  ];
  const out = storeToMemoryMessages(messages, 10_000);
  assert.deepEqual(out.map((m) => [m.id, m.role]), [["u", "user"], ["a", "assistant"], ["i", "user"]]);
  assert.equal(out[1].content, 'Reading it.\nTool grep: {"pattern":"bug"} -> src/a.ts:14: bug');
  assert.equal(out[2].content, "Image from the tool call above:\n[image]");
  assert.ok(!out[2].content.includes("AAAA"), "image data never reaches the summarizer");
});

test("skips appended context: it is per-turn state, not history", () => {
  const out = storeToMemoryMessages(
    [{ id: "c", role: "user", parts: [{ type: "text", content: "<todo>…</todo>" }], timestamp: 1, synthetic: "context" }],
    10_000,
  );
  assert.deepEqual(out, []);
});
