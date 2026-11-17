import test from "node:test";
import assert from "node:assert/strict";
import { createAgentLoop } from "./loop.js";
import { createLoopHealthEvaluator } from "../effect/loop-health.js";
import { DEFAULT_LOOP_HEURISTICS } from "./types.js";

// Signal D: near-identical reasoning text for N consecutive turns. No test
// file existed for this signal before — a pre-existing gap found while
// auditing B/C for the same "warn never reaches the model" bug.

function health(loop: unknown) {
  return createLoopHealthEvaluator().evaluate(
    (loop as any).state,
    (loop as any).config.heuristics,
  );
}

test("distinct reasoning each turn never trips the signal", () => {
  const loop = createAgentLoop("test-reasoning-distinct");
  for (let i = 0; i < DEFAULT_LOOP_HEURISTICS.reasoningSimilarityTurns + 3; i++) {
    (loop as any).advanceReasoningSimilarity(
      `Looking at file ${i}, considering approach ${i} for the problem`,
      (loop as any).config.heuristics,
    );
  }
  assert.equal((loop as any).state.loopHealth.repeatedReasoningScore, 0);
  assert.equal(health(loop).action, "continue");
});

test("near-identical reasoning for N turns warns", () => {
  const loop = createAgentLoop("test-reasoning-warn");
  const turns = DEFAULT_LOOP_HEURISTICS.reasoningSimilarityTurns;
  const text = "I need to check the config file to see what is set there";
  for (let i = 0; i <= turns; i++) {
    (loop as any).advanceReasoningSimilarity(text, (loop as any).config.heuristics);
  }
  const action = health(loop);
  assert.equal(action.action, "warn");
  assert.equal(action.reason, "repeated_reasoning");
});

test("near-identical reasoning for 2x N turns forces a text-only reply, not a bare stop", () => {
  const loop = createAgentLoop("test-reasoning-force-text");
  const turns = DEFAULT_LOOP_HEURISTICS.reasoningSimilarityTurns;
  const text = "I need to check the config file to see what is set there";
  for (let i = 0; i <= turns * 2; i++) {
    (loop as any).advanceReasoningSimilarity(text, (loop as any).config.heuristics);
  }
  const action = health(loop);
  // Not "stop": forcing a text-only reply (toolChoice: "none") removes the
  // one place the repeated thought had to go, which can itself break the
  // loop — a bare stop would just discard whatever the model was doing.
  assert.equal(action.action, "force_text");
  assert.equal(action.reason, "repeated_reasoning");
});

test("a single different turn resets the score", () => {
  const loop = createAgentLoop("test-reasoning-reset");
  const turns = DEFAULT_LOOP_HEURISTICS.reasoningSimilarityTurns;
  const text = "I need to check the config file to see what is set there";
  for (let i = 0; i <= turns; i++) {
    (loop as any).advanceReasoningSimilarity(text, (loop as any).config.heuristics);
  }
  assert.equal(health(loop).action, "warn");

  (loop as any).advanceReasoningSimilarity(
    "A completely different line of thought about something else entirely",
    (loop as any).config.heuristics,
  );
  assert.equal((loop as any).state.loopHealth.repeatedReasoningScore, 0);
  assert.equal(health(loop).action, "continue");
});
