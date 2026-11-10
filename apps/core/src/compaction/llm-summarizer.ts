import type { AIProvider } from "../providers/types.js";
import type { MemoryAuxiliaryObserver } from "../memory/auxiliary.js";
import type { MemoryMessage } from "./types.js";
import type { SummarizeInput } from "./summarizer.js";

/**
 * Produces the markdown body of a compaction summary. Throws on failure so the
 * caller can fall back to the heuristic summarizer.
 */
export type LlmSummarize = (input: SummarizeInput) => Promise<string>;

const SYSTEM_PROMPT = `You compress a coding-assistant session into a concise handoff summary so work can continue after older messages are dropped.

Output GitHub-flavored markdown using exactly these section headers, in this order:
## Goal
## Done
## In Progress
## Blocked
## Decisions
## Relevant Files
## Next Steps

Rules:
- Be factual and terse. Do not invent progress that isn't in the transcript.
- Preserve exact file paths, identifiers, commands, and unresolved errors.
- Under "Blocked", list only real, still-open blockers.
- If a section has nothing, write "- (none)".`;

function renderTranscript(messages: MemoryMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}

export function createLlmSummarizer(
  provider: AIProvider,
  model: string | undefined,
  abortSignal?: AbortSignal,
  onAuxiliaryCall?: MemoryAuxiliaryObserver,
): LlmSummarize {
  return async (input) => {
    const parts: string[] = [];
    if (input.previousSummary) {
      parts.push(
        `Previous summary (carry forward and update, don't repeat verbatim):\n\n${input.previousSummary}`,
      );
    }
    parts.push(
      `Session transcript to summarize:\n\n${renderTranscript(input.messages)}`,
    );

    const startedAt = Date.now();
    let result;
    try {
      result = await provider.execute({
        system: SYSTEM_PROMPT,
        prompt: parts.join("\n\n---\n\n"),
        model,
        // No temperature: reasoning models reject it (the AI SDK drops it with
        // a warning on every compaction), and opencode leaves it unset too.
        // The cap counts reasoning tokens: at 1_024 GLM-5.3 spent all of it
        // thinking on a 60-message transcript, returning nothing (2 of 3) or a
        // summary cut off mid-section. A cap, not a spend — a model that does
        // not think stops when the summary is done.
        maxTokens: 8_192,
        abortSignal,
      });
    } catch (error) {
      onAuxiliaryCall?.({
        purpose: "compaction",
        provider: provider.info.id,
        model,
        duration_ms: Date.now() - startedAt,
        outcome: "failed",
      });
      throw error;
    }

    // The provider attempt succeeded even if its content is unusable. Record
    // that one billed attempt before applying the semantic response check.
    onAuxiliaryCall?.({
      purpose: "compaction",
      provider: result.provider,
      model: result.model,
      duration_ms: Date.now() - startedAt,
      outcome: "succeeded",
      usage: result.usage,
    });
    const content = result.content?.trim();
    if (!content) throw new Error("provider returned an empty summary");
    // A summary cut off at the cap replaces the transcript it summarises, and
    // its missing sections are silently lost; the heuristic is complete.
    if (result.stopReason === "max_tokens")
      throw new Error("provider truncated the summary at maxTokens");
    return content;
  };
}
