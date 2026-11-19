import test from "node:test";
import assert from "node:assert/strict";
import { selectForCompaction } from "./selector.js";
import {
  DEFAULT_COMPACTION_CONFIG,
  type MemoryMessage,
} from "./types.js";

function msg(
  id: string,
  role: MemoryMessage["role"],
  content: string,
  tokenCount = 100,
): MemoryMessage {
  return { id, role, content, tokenCount, timestamp: Number(id) };
}

test("selectForCompaction preserves the recent tail and summarizes older messages", () => {
  const messages = [
    msg("1", "user", "old request"),
    msg("2", "assistant", "old answer"),
    msg("3", "user", "middle request"),
    msg("4", "assistant", "middle answer"),
    msg("5", "user", "latest request"),
    msg("6", "assistant", "latest answer"),
  ];

  const result = selectForCompaction(messages, DEFAULT_COMPACTION_CONFIG);

  // "1" is the founding user instruction and is carved out of the summary.
  assert.deepEqual(
    result.summarize.map((item) => item.id),
    ["2"],
  );
  assert.deepEqual(
    result.preserve.map((item) => item.id),
    ["1", "3", "4", "5", "6"],
  );
});

test("selectForCompaction never summarizes the founding instruction away", () => {
  const messages = [
    msg("1", "user", "build a parser for TOML"),
    ...Array.from({ length: 20 }, (_, i) =>
      msg(String(i + 2), i % 2 === 0 ? "assistant" : "user", `chatter ${i}`),
    ),
  ];

  // Compact twice: the second pass is where the old code re-summarized the
  // summary of the brief.
  const first = selectForCompaction(messages, DEFAULT_COMPACTION_CONFIG);
  assert.equal(first.preserve[0].id, "1");
  assert.ok(!first.summarize.some((m) => m.id === "1"));

  const second = selectForCompaction(first.preserve, DEFAULT_COMPACTION_CONFIG);
  assert.equal(second.preserve[0].id, "1");
  assert.ok(!second.summarize.some((m) => m.id === "1"));
});

test("a head too large to be a brief is summarized like anything else", () => {
  const messages = [
    msg("1", "user", "a pasted 50k spec", 50_000),
    msg("2", "assistant", "ack"),
    msg("3", "user", "middle"),
    msg("4", "assistant", "middle answer"),
    msg("5", "user", "latest"),
    msg("6", "assistant", "latest answer"),
  ];

  const result = selectForCompaction(messages, DEFAULT_COMPACTION_CONFIG);

  assert.ok(result.summarize.some((m) => m.id === "1"));
  assert.equal(result.preserve[0].id, "3");
});

test("selectForCompaction returns no summarize set when history is too short", () => {
  const messages = [
    msg("1", "user", "latest"),
    msg("2", "assistant", "answer"),
  ];
  const result = selectForCompaction(messages, DEFAULT_COMPACTION_CONFIG);

  assert.deepEqual(result.summarize, []);
  assert.deepEqual(
    result.preserve.map((item) => item.id),
    ["1", "2"],
  );
});

test("selectForCompaction compacts a single-prompt run (tool turns are assistant messages)", () => {
  // `freecode run` / bench / eval: one user message, then only tool turns.
  const messages = [
    msg("1", "user", "make it faster"),
    ...Array.from({ length: 40 }, (_, i) => msg(String(i + 2), "assistant", `tool turn ${i}`)),
  ];

  const result = selectForCompaction(messages, DEFAULT_COMPACTION_CONFIG);

  assert.equal(result.summarize.length, 38);
  // The prompt is carved out, then the last preserveRecentTurns messages.
  assert.deepEqual(
    result.preserve.map((item) => item.id),
    ["1", "40", "41"],
  );
});

test("selectForCompaction leaves a short single-prompt run alone", () => {
  const messages = [msg("1", "user", "hi"), msg("2", "assistant", "hello")];
  const result = selectForCompaction(messages, DEFAULT_COMPACTION_CONFIG);
  assert.deepEqual(result.summarize, []);
  assert.equal(result.preserve.length, 2);
});

test("a cutoff summarizes exactly the messages older than the store's first kept one", () => {
  const messages = [
    msg("1", "user", "the brief"),
    msg("2", "assistant", "tool turn"),
    msg("3", "assistant", "tool turn"),
    msg("4", "assistant", "tool turn"),
    msg("5", "assistant", "tool turn"),
  ];
  const result = selectForCompaction(messages, DEFAULT_COMPACTION_CONFIG, 4);
  // One user turn: the old selector would have kept the last 2 messages.
  assert.deepEqual(result.summarize.map((m) => m.id), ["2", "3"]);
  assert.deepEqual(result.preserve.map((m) => m.id), ["1", "4", "5"]);
});

test("a cutoff that selects nothing falls back to the selector's own cut", () => {
  // resetTranscript() stamps every message "now", after any stored cutoff.
  const messages = [
    msg("10", "user", "a"),
    msg("11", "assistant", "b"),
    msg("12", "user", "c"),
    msg("13", "assistant", "d"),
    msg("14", "user", "e"),
    msg("15", "assistant", "f"),
  ];
  const withCutoff = selectForCompaction(messages, DEFAULT_COMPACTION_CONFIG, 1);
  const without = selectForCompaction(messages, DEFAULT_COMPACTION_CONFIG);
  assert.deepEqual(withCutoff, without);
});
