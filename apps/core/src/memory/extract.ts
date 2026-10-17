// =============================================================================
// Memory extraction - mine a finished turn for durable facts.
// Runs at natural completion, fire-and-forget, and never throws into the loop
// (spec 2026-08-09-memory-write-path.md, D5).
// =============================================================================

import { getProvider } from "../providers/index.js";
import type { ProviderId } from "../providers/index.js";
import { getMemoryStore } from "./mem-store.js";
import { AUTHORABLE_MEMORY_TYPES, type MemoryType } from "./mem-types.js";
import { containsSecret } from "./graph/secret-filter.js";
import { lexicalSimilarity } from "./graph/index.js";
import { isSubtractive } from "./claim-subset.js";
import { anchorClaims } from "./claim-anchors.js";
import { BusEvents } from "../bus/index.js";
import { logger } from "../utils/logger.js";
import type { MemoryAuxiliaryObserver } from "./auxiliary.js";
import type { ExtractionTrace, MemoryWriteTrace } from "./failure-trace.js";

// A runaway extractor fills the store with noise faster than anything cleans it
// up, and there is no consolidation pass yet. Bound it hard.
export const MAX_SAVES_PER_RUN = 3;

// Enough transcript to judge durability without paying for a whole session.
const MAX_TRANSCRIPT_CHARS = 12_000;

const SYSTEM = `You extract durable memories from a coding session.

Return ONLY a JSON array, no prose. Each element:
{"type": "user|feedback|project|reference", "name": "kebab-case-slug", "description": "one specific line", "content": "the memory"}

Save only what will still be true next week:
- user: who they are, how they like to work
- feedback: guidance they gave you; add **Why:** and **How to apply:** lines
- project: decisions, constraints, deadlines not derivable from the code
- reference: pointers to external systems

Never save: anything derivable from the code, git history, or project docs; how a
bug was fixed; task details that stop mattering when this task ends; credentials.

Instructions such as "just acknowledge", "don't edit yet", "don't change files
right now", or "only tell me" apply only to that turn. Never save them or carry
them into a memory's description/content. Save the durable fact underneath them.
When the user gives a concrete enduring rule, identifier, value, or correction
that is not in the repository, save it even when the turn asks for no edit.

Most turns contain nothing worth saving. Returning [] is the common, correct
answer — prefer it over a weak memory. Never return more than ${MAX_SAVES_PER_RUN}.`;

export interface ExtractInput {
  transcript: string;
  projectPath: string;
  provider: string;
  model?: string;
  /** Emits memory.saved so the user is told. Omit to save silently (tests). */
  sessionId?: string;
  /** Test seam; defaults to a one-shot provider call. */
  complete?: (system: string, prompt: string) => Promise<string>;
  /** Reports provider usage when this path makes a real auxiliary call. */
  onAuxiliaryCall?: MemoryAuxiliaryObserver;
  /** Records the write path for failure diagnosis (plan 2026-10-15 §5 Phase 0). */
  trace?: MemoryWriteTrace;
}

interface Proposal {
  type: MemoryType;
  name: string;
  description: string;
  content: string;
}

// Models wrap JSON in prose or a fence however much you ask them not to.
function parseProposals(raw: string): Proposal[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: Proposal[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const type = typeof p.type === "string" ? p.type.toLowerCase() : "";
    // Episodes are machine-written (D5); an extractor proposal claiming to be
    // one is exactly the self-narration failure mode the tool refuses too.
    if (!(AUTHORABLE_MEMORY_TYPES as readonly string[]).includes(type))
      continue;
    if (
      typeof p.name !== "string" ||
      typeof p.description !== "string" ||
      typeof p.content !== "string"
    ) {
      continue;
    }
    const name = p.name.trim();
    const description = p.description.trim();
    const content = p.content.trim();
    if (!name || !description || !content) continue;
    out.push({ type: type as MemoryType, name, description, content });
  }
  return out;
}

function userTexts(transcript: string): string[] {
  return [
    ...transcript.matchAll(
      /(?:^|\n)user:\s*([\s\S]*?)(?=\n(?:user|assistant):|$)/gi,
    ),
  ]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function latestUserText(transcript: string): string {
  return userTexts(transcript).at(-1) ?? "";
}

function latestConcreteUserText(transcript: string): string {
  return (
    userTexts(transcript)
      .reverse()
      .find((text) => anchorClaims(text).length >= 2) ?? ""
  );
}

/**
 * The provider is free to return proposals in any order.  When the bounded
 * write cap is hit, keeping the first N silently drops the fact from the last
 * user message — exactly the fact most likely to be needed on the next turn.
 * Rank only when there is competition, using the latest user message as a
 * salience signal; ties retain provider order for deterministic behavior.
 */
function prioritizeLatest(proposals: Proposal[], transcript: string): Proposal[] {
  if (proposals.length <= MAX_SAVES_PER_RUN) return proposals;
  const latestUser =
    latestConcreteUserText(transcript) || latestUserText(transcript);
  if (!latestUser) return proposals;
  const ranked = proposals
    .map((proposal, index) => ({
      proposal,
      index,
      score: lexicalSimilarity(
        latestUser,
        `${proposal.name} ${proposal.description} ${proposal.content}`,
      ),
    }));
  // A single shared stop-word such as "the" is not evidence of relevance.
  // Reuse the graph's topic threshold so generic transcripts retain provider
  // order rather than causing an arbitrary reorder at the cap.
  if (Math.max(...ranked.map((entry) => entry.score)) < 0.12) return proposals;
  return ranked.sort((a, b) => b.score - a.score || a.index - b.index).map(({ proposal }) => proposal);
}

async function oneShot(
  input: ExtractInput,
  system: string,
  prompt: string,
): Promise<string> {
  const provider = getProvider(input.provider as ProviderId);
  if (!provider) return "";
  const startedAt = Date.now();
  try {
    const result = await provider.execute({
      prompt,
      system,
      model: input.model,
      quietModelFallback: true,
      maxTokens: 1024,
    });
    input.onAuxiliaryCall?.({
      purpose: "extraction",
      provider: input.provider,
      model: result.model || input.model,
      duration_ms: Date.now() - startedAt,
      outcome: "succeeded",
      usage: result.usage,
    });
    return result.content ?? "";
  } catch (error) {
    input.onAuxiliaryCall?.({
      purpose: "extraction",
      provider: input.provider,
      model: input.model,
      duration_ms: Date.now() - startedAt,
      outcome: "failed",
    });
    throw error;
  }
}

/**
 * Extract and save durable memories from a finished turn.
 * Returns how many were saved. Never throws — a memory failure must be
 * invisible to the user's task.
 */
export async function extractMemories(input: ExtractInput): Promise<number> {
  try {
    const transcript = input.transcript.trim();
    if (transcript.length === 0) return 0;

    const complete = input.complete ?? ((s, p) => oneShot(input, s, p));
    let raw = await complete(
      SYSTEM,
      `Session transcript:\n\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`,
    );
    let parsed = parseProposals(raw);
    const latestConcreteUser = latestConcreteUserText(transcript);
    // A cheap extractor occasionally returns [] for an explicit value-bearing
    // fact even though the latest user message contains several concrete
    // anchors (for example `ap-northeast-1` and `10`). Give only that narrow
    // contradiction one second look. Generic chatter and genuine empty turns
    // still cost one call, and the hard write cap remains unchanged.
    if (parsed.length === 0 && latestConcreteUser) {
      raw = await complete(
        SYSTEM,
        `Re-evaluate the latest user message. It contains concrete identifiers ` +
          `or values, so returning [] is correct only if they are not durable. ` +
          `Do not save turn-local no-edit or acknowledgement instructions.\n\n` +
          `Latest concrete user message:\n${latestConcreteUser}\n\n` +
          `Session transcript:\n\n${transcript.slice(-MAX_TRANSCRIPT_CHARS)}`,
      );
      parsed = parseProposals(raw);
    }

    const proposals = prioritizeLatest(parsed, transcript);
    const stage: ExtractionTrace = {
      candidates: proposals.map((p) => p.content),
      accepted: [],
      replaced: [],
      skipped: [],
      live: [],
    };
    if (proposals.length === 0) {
      recordExtraction(input, stage);
      return 0;
    }

    const store = getMemoryStore(input.projectPath);
    const savedEntries: Array<{ type: string; name: string }> = [];
    let saved = 0;
    for (const p of proposals) {
      // Record the refusal instead of `break`ing: nothing past the cap could be
      // saved anyway, and the dropped candidate is what Phase 0 needs to see.
      if (saved >= MAX_SAVES_PER_RUN) {
        stage.skipped.push({ body: p.content, reason: "cap" });
        continue;
      }
      // Same rule as the tool (D4): credentials are never written to disk.
      if (containsSecret(`${p.description}\n${p.content}`)) {
        stage.skipped.push({ body: p.content, reason: "secret" });
        continue;
      }

      const existing = store.load(p.name, p.type);
      // Nothing changed — skip rather than churn the file's mtime and force a
      // pointless re-embed through onMemoryChange.
      if (
        existing &&
        existing.content === p.content &&
        existing.description === p.description
      ) {
        stage.skipped.push({ body: p.content, reason: "unchanged" });
        continue;
      }

      // A rewrite carrying fewer facts than the entry already holds, with none
      // of its own, is a silent loss rather than an update (plan 2026-10-15 §5
      // Phase 1). The entry keeps what it had; an update, which brings a claim
      // of its own, is untouched by this.
      if (existing && isSubtractive(existing.content, p.content)) {
        stage.skipped.push({ body: p.content, reason: "lossy" });
        continue;
      }

      // A reused name is normally an intentional correction or expansion. A
      // low-overlap rewrite that also drops anchored claims is different: it
      // is usually the extractor reusing a topic slug for a second fact. Keep
      // both bodies rather than silently destroying the first fact; later
      // consolidation can merge them once it has the full candidate set.
      const collision =
        existing &&
        lexicalSimilarity(existing.content, p.content) < 0.12;
      const content = collision
        ? `${existing.content}\n\n${p.content}`
        : p.content;
      const description = collision
        ? `${existing.description}; ${p.description}`
        : p.description;

      if (existing) {
        stage.replaced.push({
          name: p.name,
          before: existing.content,
          after: content,
        });
      }
      stage.accepted.push(content);

      const now = Date.now();
      store.save({
        name: p.name,
        description,
        type: p.type,
        content,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        // The extractor knows nothing about graph metadata; dropping it here
        // would sever the entry's HasTag/Supersedes edges on every update.
        tags: existing?.tags,
        supersedes: existing?.supersedes,
        happened_at: existing?.happened_at,
      });
      saved++;
      savedEntries.push({ type: p.type, name: p.name });
    }

    recordExtraction(input, stage);

    // Tell the user something was recorded about them. Emitted on the bus, not
    // the turn stream: extraction runs after the turn's `done`, so the stream
    // is closed by now — the bus speaker wire is always live.
    if (savedEntries.length > 0 && input.sessionId) {
      BusEvents.memorySaved(input.sessionId, savedEntries);
    }
    return saved;
  } catch (error) {
    logger.debug("[MemoryExtract] extraction failed", { error });
    return 0;
  }
}

/**
 * Seal the extraction stage. "Final live entries" is the whole store, not this
 * pass's writes — a fact taught in an earlier session is still live, and only a
 * pass that took it away should look like a loss.
 *
 * Skipped entirely unless the caller asked for a trace, so ordinary extraction
 * does not pay for a directory walk nothing reads.
 */
function recordExtraction(input: ExtractInput, stage: ExtractionTrace): void {
  if (!input.trace) return;
  stage.live = getMemoryStore(input.projectPath)
    .list()
    .map((e) => e.content);
  input.trace.extraction = stage;
}
