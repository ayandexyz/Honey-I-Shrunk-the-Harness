import type {
  CompactionConfig,
  MemoryMessage,
  SelectionResult,
} from "./types.js";

function countTokens(messages: MemoryMessage[]): number {
  return messages.reduce((sum, message) => sum + message.tokenCount, 0);
}

export function selectForCompaction(
  messages: MemoryMessage[],
  config: CompactionConfig,
): SelectionResult {
  // Preserve the tail from the Nth-most-recent user turn. A headless run
  // (`freecode run`, the bench, an eval case) has ONE user message for its
  // whole life — tool turns are recorded as `assistant` — so counting only
  // user turns left it uncompactable at any size (bench runs averaged ~200K
  // input/turn against a 120K target). When there are fewer user turns than
  // N, fall back to preserving the last N messages; the head carve-out below
  // keeps the prompt itself.
  let userTurnsSeen = 0;
  let preserveStart = Math.max(0, messages.length - config.preserveRecentTurns);

  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") {
      userTurnsSeen++;
      if (userTurnsSeen === config.preserveRecentTurns) {
        preserveStart = index;
        break;
      }
    }
  }

  let preserve = messages.slice(preserveStart);
  while (
    countTokens(preserve) > config.maxPreserveRecentTokens &&
    preserve.length > 1
  ) {
    preserve = preserve.slice(1);
  }

  const firstPreservedId = preserve[0]?.id;
  const firstPreservedIndex = firstPreservedId
    ? messages.findIndex((message) => message.id === firstPreservedId)
    : messages.length;
  let summarize = messages.slice(0, Math.max(0, firstPreservedIndex));

  // Head carve-out. The founding instruction is the first thing compacted
  // away otherwise, and on the *next* compaction the summary of it is
  // summarized again — the brief decays faster than anything else in the
  // window, which is the plausible mechanism behind long-session drift off
  // the task. Keeping it verbatim costs a bounded, one-off few hundred
  // tokens. It is prepended after the tail-trimming loop above deliberately:
  // trimming must never be able to evict the brief.
  const headIndex = summarize.findIndex((message) => message.role === "user");
  const head = headIndex === -1 ? undefined : summarize[headIndex];
  if (head && head.tokenCount <= config.maxPreserveHeadTokens) {
    summarize = summarize.filter((message) => message.id !== head.id);
    preserve = [head, ...preserve];
  }

  return {
    summarize,
    preserve,
    summarizeTokenCount: countTokens(summarize),
    preserveTokenCount: countTokens(preserve),
  };
}
