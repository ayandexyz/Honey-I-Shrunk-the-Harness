import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldNudgeTodo,
  todoNudgeReminder,
  TODO_NUDGE_TURNS,
  TODO_NUDGE_GAP,
  noProgressReminder,
  oscillationReminder,
  repeatedReasoningReminder,
} from "./reminders.js";
test("nudge respects the turn threshold and inter-nudge gap", () => {
  // Not enough idle turns yet.
  assert.equal(shouldNudgeTodo(TODO_NUDGE_TURNS - 1, TODO_NUDGE_GAP), false);
  // Idle long enough and gap satisfied.
  assert.equal(shouldNudgeTodo(TODO_NUDGE_TURNS, TODO_NUDGE_GAP), true);
  // Idle long enough but nudged too recently.
  assert.equal(shouldNudgeTodo(TODO_NUDGE_TURNS, TODO_NUDGE_GAP - 1), false);
});

test("nudge text is a system-reminder that mentions todowrite", () => {
  assert.match(todoNudgeReminder(), /<system-reminder>/);
  assert.match(todoNudgeReminder(), /todowrite/);
});

test("thresholds are Claude Code's 10/10; FREECODE_TODO_NUDGE=legacy restores 3/5 per call", () => {
  assert.equal(TODO_NUDGE_TURNS, 10);
  assert.equal(TODO_NUDGE_GAP, 10);
  const legacy = { FREECODE_TODO_NUDGE: "legacy" };
  assert.equal(shouldNudgeTodo(3, 5, {}), false);
  assert.equal(shouldNudgeTodo(3, 5, legacy), true);
  assert.equal(shouldNudgeTodo(2, 5, legacy), false);
});

test("the nudge is gentle, and with a list it asks for cleanup rather than a plan", () => {
  const fresh = todoNudgeReminder(false, {});
  assert.match(fresh, /gentle reminder/);
  assert.match(fresh, /ignore if not applicable/);
  assert.match(fresh, /Only use it if it's relevant/);
  assert.doesNotMatch(fresh, /maintain a todo list/);
  const withList = todoNudgeReminder(true, {});
  assert.match(withList, /cleaning up the todo list/);
  assert.match(todoNudgeReminder(true, { FREECODE_TODO_NUDGE: "legacy" }), /maintain a todo list/);
});

test("noProgressReminder names the turn count and tells a read-only task to just answer", () => {
  const text = noProgressReminder(5);
  assert.match(text, /<system-reminder>/);
  assert.match(text, /5 turns/);
  // The point of this reminder (unlike repeatedCallReminder) is that a
  // read-only exploration task is not itself a failure — only continuing to
  // explore past the threshold is. It must not read as "you did something
  // wrong" for a task that was never going to edit anything.
  assert.match(text, /stop exploring and/);
  assert.doesNotMatch(text, /run will be stopped/);
});

test("oscillationReminder names the file and the revert count", () => {
  const text = oscillationReminder("src/foo.ts", 4);
  assert.match(text, /<system-reminder>/);
  assert.match(text, /src\/foo\.ts/);
  assert.match(text, /4 times/);
  assert.match(text, /tools will be taken away/);
});

test("repeatedReasoningReminder names the turn count", () => {
  const text = repeatedReasoningReminder(3);
  assert.match(text, /<system-reminder>/);
  assert.match(text, /3 turns/);
  assert.match(text, /tools will\s+be taken away/);
});
