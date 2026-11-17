// =============================================================================
// Loop Health Evaluator
// PRIMARY: Multi-heuristic loop detection
// INPUT: SessionState + LoopHeuristics
// OUTPUT: LoopAction { continue | warn | stop }
// PURPOSE: Detects stuck patterns (repeated tools, stagnation, oscillation)
//          NOTE: moved here from effect/layers.ts when layers.ts became the
//          Layer wiring module (Phase 3 of the optimisation plan).
//          This is the ONLY copy of the policy — AgentLoop had a second,
//          identical private evaluateLoopHealth() until it was collapsed into
//          this one (spec 2026-08-26-trajectory-redirection.md, D10).
// =============================================================================

import type {
  SessionState,
  LoopHeuristics,
  LoopAction,
} from "../agent/types.js";
import { isReadOnlyMode } from "../permission/mode-policy.js";

export interface LoopHealthEvaluator {
  evaluate(state: SessionState, heuristics: LoopHeuristics): LoopAction;
}

export const createLoopHealthEvaluator = (): LoopHealthEvaluator => ({
  evaluate(state: SessionState, heuristics: LoopHeuristics): LoopAction {
    const health = state.loopHealth;

    // Two-tier braking: legitimate long tasks routinely re-read a file or edit
    // one file several times, so the first breach only warns; a hard stop is
    // reserved for 2× the threshold, where the pattern is almost certainly a
    // genuine loop. This keeps a runaway safety net without killing real work.

    // A. Repeated identical tool call - likely infinite loop
    if (health.repeatedTools >= heuristics.repeatedIdenticalThreshold * 2) {
      return { action: "stop", reason: "repeated_identical_tool" };
    }
    if (health.repeatedTools >= heuristics.repeatedIdenticalThreshold) {
      return { action: "warn", reason: "repeated_identical_tool" };
    }

    // E. The same located error back in bash output across edits — the stuck
    // case A–D cannot see, because the calls and files keep changing. Warn
    // only (spec 2026-10-13-stuck-loop-recovery.md §5.1.1): neither
    // claude-code nor opencode ever stops a run on this, and no recorded run
    // reached a stop threshold to calibrate on.
    if (health.repeatedError >= heuristics.repeatedErrorThreshold) {
      return { action: "warn", reason: "repeated_error" };
    }

    // B. No file change for N *turns* — the counter is advanced once per turn
    // by AgentLoop.advanceStagnation(), never per tool call. Unlike A/C/D,
    // the 2x tier is `force_text` rather than `stop`: a read-only
    // exploration task (varied grep/read, never identical, so A never
    // trips) legitimately has no file change to show, so ending the run
    // with a bare "Loop stopped" would discard real findings the model
    // already has. Forcing a text-only reply lets it answer with what it
    // found instead (session that exposed this: 22 turns of varied
    // grep/read, no edits, cut off only by the eval harness's own trial
    // timeout — see noProgressReminder's comment in reminders.ts).
    //
    // plan/review/explore modes: "no file changed" is always true there, so
    // the 1x `warn` tier would fire every single turn — noise, not signal.
    // Only `force_text`, against a much higher, mode-specific limit, applies
    // (see readOnlyExplorationLimit's comment in types.ts for the session
    // that exposed THIS gap: 21 turns, zero loop-health signal at all, only
    // the eval harness's own trial timeout — and it cut the model off
    // mid-generation, with no chance to answer).
    if (isReadOnlyMode(state.agentMode)) {
      if (health.stagnantTurns >= heuristics.readOnlyExplorationLimit) {
        return { action: "force_text", reason: "no_progress" };
      }
    } else {
      // Build mode: opt-in (FREECODE_STAGNATION_FORCE_TEXT=1, read per call
      // so `eval ab` can flip it). Bash runs and reads never reset this
      // counter, so a normal debugging run (read, grep, run the tests, read
      // again) reaches 10 turns before its first edit — taking its tools
      // away there is a behaviour change no eval has measured yet.
      if (
        process.env.FREECODE_STAGNATION_FORCE_TEXT === "1" &&
        health.stagnantTurns >= heuristics.stagnantTurnsThreshold * 2
      ) {
        return { action: "force_text", reason: "no_progress" };
      }
      if (health.stagnantTurns >= heuristics.stagnantTurnsThreshold) {
        return { action: "warn", reason: "no_progress" };
      }
    }

    // C. Oscillation detected - edit/revert/edit pattern. The score counts
    // reverts inside the recent-edit window, so it can fall as well as rise.
    // 2x tier is `force_text`, not `stop`, for the same reason as B: the
    // model has made real edits (just contradictory ones), and a bare "Loop
    // stopped" would discard whatever understanding led to them instead of
    // asking it to explain the conflict or commit to one side.
    if (health.oscillationScore >= heuristics.oscillationScoreThreshold * 2) {
      return { action: "force_text", reason: "oscillation_detected" };
    }
    if (health.oscillationScore >= heuristics.oscillationScoreThreshold) {
      return { action: "warn", reason: "oscillation_detected" };
    }

    // D. Repeated reasoning similarity - near-identical reasoning text for N
    // consecutive turns, tracked by AgentLoop.advanceReasoningSimilarity().
    // 2x tier is `force_text`: toolChoice:"none" removes the only other
    // option, which can itself break a thought-loop that kept recurring
    // only because tool calls gave it somewhere to go instead of concluding.
    if (health.repeatedReasoningScore >= heuristics.reasoningSimilarityTurns * 2) {
      return { action: "force_text", reason: "repeated_reasoning" };
    }
    if (health.repeatedReasoningScore >= heuristics.reasoningSimilarityTurns) {
      return { action: "warn", reason: "repeated_reasoning" };
    }

    // F. Hard cap on iterations
    if (state.iterationCount >= heuristics.totalIterationLimit) {
      return { action: "stop", reason: "max_iterations_reached" };
    }

    return { action: "continue" };
  },
});
