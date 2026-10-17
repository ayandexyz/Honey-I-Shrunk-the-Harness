// =============================================================================
// Memory failure trace — names the stage that lost a fact.
//
// Spec: docs/specs/2026-08-09-memory-write-path.md; priority plan 2026-10-15 §5
// Phase 0. Diagnosis, not prompt tuning: a durable fact can die at six places
// between "the turn taught it" and "the model read it", and the fix has to
// target the one that actually loses it.
//
// Where each stage comes from:
//   extraction / consolidation — recorded by `extractMemories` and
//     `consolidateMemories` when the caller passes a trace (see the `trace`
//     field on their inputs).
//   retrieved / judged / rendered — supplied by the turn that selected
//     memories: the cascade's selection, the judge's keepers, and the entries
//     the byte budget let through (`RenderedMemories.entries`).
//
// The trace is in-memory and per-pass. Nothing here writes to the rollout log,
// OTLP, or disk: the plan forbids memory bodies in those sinks, and Phase 0
// needs the record only inside the fixtures that reproduce the failures.
// =============================================================================

/** The six ways a fact can fail to reach the model (plan §5 Phase 0). */
export type MemoryFailureCause =
  | "extraction_omission"
  | "save_collision"
  | "consolidation_omission"
  | "retrieval_miss"
  | "judge_rejection"
  | "rendering_budget_drop";

/** "present" = at every stage that was recorded; "unmeasured" = none was. */
export type MemoryFactPresence = "present" | "unmeasured";

/** Why an extracted candidate never reached the store. */
export type ExtractionDropReason = "cap" | "secret" | "unchanged";

/** Recorded by `extractMemories`. Bodies are `MemoryEntry.content`. */
export interface ExtractionTrace {
  /** Bodies the extractor proposed, in proposal order. */
  candidates: string[];
  /** Candidate bodies written this pass. */
  accepted: string[];
  /** Same-name writes: what the name held before and what it holds now. */
  replaced: Array<{ name: string; before: string; after: string }>;
  /** Candidates the write path refused, in evaluation order. */
  skipped: Array<{ body: string; reason: ExtractionDropReason }>;
  /** Every body live in the store after the pass — not just this pass's writes. */
  live: string[];
}

/** Recorded by `consolidateMemories`. Bodies are `MemoryEntry.content`. */
export interface ConsolidationTrace {
  /** Bodies of the entries the model was shown, captured before the merge. */
  sources: string[];
  /** Bodies the accepted merges wrote. */
  proposal: string[];
  /** Every body live in the store after the pass. */
  live: string[];
  /** Names the pass removed — merge victims and retention overflow. */
  deleted: string[];
}

/**
 * Out-parameter for the write-path functions, matching the existing
 * `onAuxiliaryCall` seam: pass an object and the pass fills its own stage in.
 * A stage that is absent was not observed, which the classifier treats as
 * unknown rather than as a loss.
 */
export interface MemoryWriteTrace {
  extraction?: ExtractionTrace;
  consolidation?: ConsolidationTrace;
}

export interface MemoryFactStages {
  trace?: MemoryWriteTrace;
  /** Bodies the retrieval stage selected for the turn. */
  retrieved?: readonly string[];
  /** Bodies that survived the judge; omit when no judge ran. */
  judged?: readonly string[];
  /** Bodies that fit the render byte budget. */
  rendered?: readonly string[];
}

export type FactMatcher = string | RegExp;

function matches(fact: FactMatcher, body: string): boolean {
  if (typeof fact === "string") return body.includes(fact);
  // A sticky/global regex carries lastIndex across `.test` calls; a fresh copy
  // keeps the answer a function of the body alone.
  const fresh =
    fact.global || fact.sticky
      ? new RegExp(fact.source, fact.flags.replace(/[gy]/g, ""))
      : fact;
  return fresh.test(body);
}

function holds(
  bodies: readonly string[] | undefined,
  fact: FactMatcher,
): boolean {
  return bodies !== undefined && bodies.some((b) => matches(fact, b));
}

/**
 * Name the stage that lost `fact`, walking the pipeline in order.
 *
 * The **first** stage whose recorded output no longer holds the fact is the
 * cause: later stages are downstream of a loss that already happened. Stages
 * with no record are skipped, so a fact the store still holds is "present" even
 * when nothing measured retrieval.
 *
 * A fact a merge or a same-name save legitimately carries forward is not a
 * loss — the check is presence in the *new* body, not the survival of the old
 * one, so a supersession that restates the fact classifies as present.
 */
export function classifyMissingFact(
  fact: FactMatcher,
  stages: MemoryFactStages = {},
): MemoryFailureCause | MemoryFactPresence {
  const { extraction, consolidation } = stages.trace ?? {};
  const anyStage =
    extraction !== undefined ||
    consolidation !== undefined ||
    stages.retrieved !== undefined ||
    stages.judged !== undefined ||
    stages.rendered !== undefined;
  if (!anyStage) return "unmeasured";

  // Write path. "Live" is the whole store after the pass, so a fact taught in an
  // earlier session is only missing here if this pass took it away.
  if (extraction && !holds(extraction.live, fact)) {
    const replacedAway = extraction.replaced.some(
      (r) => matches(fact, r.before) && !matches(fact, r.after),
    );
    return replacedAway ? "save_collision" : "extraction_omission";
  }

  const live = consolidation?.live ?? extraction?.live ?? [];
  if (consolidation && !holds(consolidation.live, fact)) {
    return "consolidation_omission";
  }

  const retrieved = stages.retrieved ?? live;
  if (!holds(retrieved, fact)) return "retrieval_miss";

  const judged = stages.judged ?? retrieved;
  if (!holds(judged, fact)) return "judge_rejection";

  const rendered = stages.rendered ?? judged;
  if (!holds(rendered, fact)) return "rendering_budget_drop";

  return "present";
}
