import type { AIProvider } from "../providers/types.js";
import type { MemoryAuxiliaryObserver } from "../memory/auxiliary.js";
import type { MemoryMessage } from "./types.js";
import type { SummarizeInput } from "./summarizer.js";
import { isContextOverflowError } from "../agent/recovery/manager.js";

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
## Findings
## Relevant Files
## Next Steps

Rules:
- Be factual and terse. Do not invent progress that isn't in the transcript.
- Under "Goal", keep the user's request or question in their own words.
- Under "Findings", record what the tool results established that the next step relies on: where things live (path:line), how the code works, answers already found. The transcript is about to be dropped, so anything not written here has to be read again.
- Preserve exact file paths, identifiers, commands, and unresolved errors.
- Under "Blocked", list only real, still-open blockers.
- If a section has nothing, write "- (none)".`;

function renderTranscript(messages: MemoryMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
}

// Claude Code's PTL retry (truncateHeadForPTLRetry): when the summarizer's
// own request is too long, drop the oldest fifth of the transcript and try
// again, up to three times. The previous summary and the goal are never
// dropped — they carry what the oldest messages said before.
const MAX_OVERFLOW_RETRIES = 3;
const OVERFLOW_DROP_FRACTION = 0.2;
const TRUNCATED_MARKER = "[earlier transcript truncated for compaction retry]";

export function dropOldestForRetry(messages: MemoryMessage[]): MemoryMessage[] {
  if (messages.length <= 1) return messages;
  const drop = Math.max(1, Math.floor(messages.length * OVERFLOW_DROP_FRACTION));
  return messages.slice(drop);
}

export function createLlmSummarizer(
  provider: AIProvider,
  model: string | undefined,
  abortSignal?: AbortSignal,
  onAuxiliaryCall?: MemoryAuxiliaryObserver,
): LlmSummarize {
  return async (input) => {
    let messages = input.messages;
    for (let attempt = 0; ; attempt++) {
      try {
        return await summarizeOnce(input, messages, attempt > 0);
      } catch (error) {
        if (
          !isContextOverflowError(error) ||
          attempt >= MAX_OVERFLOW_RETRIES ||
          messages.length <= 1
        )
          throw error;
        messages = dropOldestForRetry(messages);
      }
    }
  };

  async function summarizeOnce(
    input: SummarizeInput,
    messages: MemoryMessage[],
    truncated: boolean,
  ): Promise<string> {
    const parts: string[] = [];
    if (input.goal) {
      parts.push(
        `The user's original request (kept verbatim in the conversation, not in the transcript below):\n\n${input.goal}`,
      );
    }
    if (input.previousSummary) {
      parts.push(
        `Previous summary (carry forward and update, don't repeat verbatim):\n\n${input.previousSummary}`,
      );
    }
    parts.push(
      `Session transcript to summarize:\n\n${truncated ? `${TRUNCATED_MARKER}\n\n` : ""}${renderTranscript(messages)}`,
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
  }
}
