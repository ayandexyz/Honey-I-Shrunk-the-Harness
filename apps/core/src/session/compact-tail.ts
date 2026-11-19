// =============================================================================
// Compaction tail by tokens — which stored messages a compaction keeps
// verbatim. pi's cut (`findCutPoint`): walk back from the newest message until
// the budget is reached, and cut at a message a conversation may start from,
// even inside a turn. Spec 2026-11-19-compaction-token-tail §3.1–3.2.
//
// Replaces keepLastNUserTurns as the default: "the last two user turns" has
// no size, so one prompt followed by an hour of tool calls (session ff9dd627)
// could never shrink.
// =============================================================================

import type { SerializedMessage } from "./store.js";
import { isUserTurn } from "./store.js";
import { estimateMessageTokens } from "../compaction/tokens.js";

/**
 * A message the kept history may begin at. Tool results ride inside their
 * assistant message, so any assistant message is safe; appended context and
 * tool images belong to what precedes them.
 */
function isCutPoint(message: SerializedMessage): boolean {
  return message.role === "assistant" || isUserTurn(message);
}

/**
 * The newest messages within the budget, starting at a cut point. The budget
 * is `cap`, but never more than half the conversation: compaction fires on
 * the provider's whole request, and when the system prompt and tools are most
 * of it (eval cases trigger at 12K with ~9.5K of overhead) a fixed tail would
 * hold the entire conversation and drop nothing. opencode's `recentStart` has
 * the same guard. When the cut falls inside a turn, the prompt that started
 * it is kept in front — the brief is what a mid-task model most needs —
 * unless the prompt alone exceeds the budget (a pasted document).
 */
export function keepRecentTokens(
  messages: SerializedMessage[],
  cap: number,
): SerializedMessage[] {
  const conversation = messages.reduce(
    (sum, m) => sum + estimateMessageTokens(m),
    0,
  );
  const budget = Math.min(cap, Math.floor(conversation / 2));
  let total = 0;
  let cut = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    total += estimateMessageTokens(messages[i]);
    if (total >= budget) {
      // The nearest cut point at or after i; if none, keep the newest message.
      cut = messages.findIndex((m, j) => j >= i && isCutPoint(m));
      if (cut === -1) cut = messages.length - 1;
      break;
    }
  }
  if (cut <= 0) return messages.slice();

  const tail = messages.slice(cut);
  if (isUserTurn(messages[cut])) return tail;
  for (let i = cut - 1; i >= 0; i--) {
    if (!isUserTurn(messages[i])) continue;
    return estimateMessageTokens(messages[i]) <= budget
      ? [messages[i], ...tail]
      : tail;
  }
  return tail;
}
