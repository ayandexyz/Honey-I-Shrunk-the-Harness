import test from "node:test";
import assert from "node:assert/strict";
import { contextToAppend, isContextText } from "./context-inject.js";

const blocks = (memoryBlock = "", todoBlock = "", reminderText = "") => ({
  memoryBlock,
  todoBlock,
  reminderText,
});

test("first delivery appends memory and todos, wrapped as reminders", () => {
  const out = contextToAppend({}, blocks("# Relevant memories\nm1", "## Current Task List\n[ ] a"));
  assert.ok(out.text);
  assert.ok(isContextText(out.text));
  assert.match(out.text, /m1[\s\S]*\[ \] a/);
  assert.equal(out.memory, true);
});

test("unchanged memory and todos append nothing — the prefix only grows", () => {
  const first = contextToAppend({}, blocks("mem", "todos"));
  const again = contextToAppend(first.delivered, blocks("mem", "todos"));
  assert.equal(again.text, undefined);
  assert.equal(again.memory, false);
});

test("only the part that changed is appended", () => {
  const first = contextToAppend({}, blocks("mem", "todos v1"));
  const next = contextToAppend(first.delivered, blocks("mem", "todos v2"));
  assert.ok(next.text?.includes("todos v2"));
  assert.ok(!next.text?.includes("mem"));
});

test("reminders are always appended (one-shot) and not double-wrapped", () => {
  const first = contextToAppend({}, blocks("mem"));
  const r = "<system-reminder>\nnudge\n</system-reminder>";
  const next = contextToAppend(first.delivered, blocks("mem", "", r));
  assert.equal(next.text, r);
});

test("an emptied todo list is remembered, so the same list returns", () => {
  const a = contextToAppend({}, blocks("", "list"));
  const emptied = contextToAppend(a.delivered, blocks("", ""));
  assert.equal(emptied.text, undefined);
  const back = contextToAppend(emptied.delivered, blocks("", "list"));
  assert.ok(back.text?.includes("list"));
});

test("a reset ledger (after compaction) re-delivers everything", () => {
  const first = contextToAppend({}, blocks("mem", "todos"));
  assert.ok(first.text);
  const afterCompaction = contextToAppend({}, blocks("mem", "todos"));
  assert.equal(afterCompaction.text, first.text);
});

test("a real prompt is not context", () => {
  assert.equal(isContextText("fix the bug"), false);
});
