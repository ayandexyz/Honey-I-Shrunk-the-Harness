// Applies compaction so it persists across turns: MemoryService produces the
// summary, and the session store is trimmed to the recent tail (by tokens,
// compact-tail.ts; or the last N user turns under FREECODE_COMPACT_TAIL=turns)
// so the NEXT turn's loadHistory() sends fewer messages.

import type { SessionStore, SerializedMessage } from "./store.js";
import { isUserTurn } from "./store.js";
import type { MemoryService } from "../compaction/service.js";
import type { CompactOptions } from "../compaction/service.js";
import { DEFAULT_COMPACTION_CONFIG } from "../compaction/types.js";
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  getCompactTailMode,
} from "../compaction/tokens.js";
import { keepRecentTokens } from "./compact-tail.js";
import { markAllReadsCompacted } from "../tools/read-state.js";

export interface ApplyCompactionResult {
  compacted: boolean;
  reason?: string;
  /** MemoryService's local transcript estimate, not provider usage. */
  tokensBefore: number;
  /** MemoryService's local transcript estimate, not provider usage. */
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  /** Session-store entry ids removed from the active provider transcript. */
  compactedMessageIds: string[];
  /** Session-store entry ids left in the active provider transcript. */
  preservedMessageIds: string[];
}

/**
 * Keep the last `n` user turns (and everything after the earliest of them).
 * The result still starts on a user message, so it stays a valid conversation.
 */
export function keepLastNUserTurns(
  messages: SerializedMessage[],
  n: number,
): SerializedMessage[] {
  if (n <= 0) return [];
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    // Appended context and tool images are the harness talking; not user turns.
    if (isUserTurn(messages[i])) {
      seen++;
      if (seen === n) return messages.slice(i);
    }
  }
  // Fewer than n user turns: a headless run (`freecode run`, bench, eval)
  // has one prompt and then only assistant turns (tool results ride inside
  // the assistant message as `tool` parts), so keeping everything meant the
  // provider-facing history never shrank — the summary was written and the
  // next request was the same size. Keep the prompt and the last n assistant
  // turns instead; the summary in the system prompt carries the rest.
  seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      seen++;
      if (seen === n) {
        const head = messages[0]?.role === "user" && i > 0 ? [messages[0]] : [];
        return [...head, ...messages.slice(i)];
      }
    }
  }
  return messages.slice();
}

export async function applyCompaction(opts: {
  memory: MemoryService;
  store: SessionStore;
  sessionId: string;
  projectPath: string;
  preserveRecentTurns?: number;
  /** Cap on the verbatim tail (default 20K; tests pass a small one). */
  keepRecentTokens?: number;
  compactOptions?: CompactOptions;
}): Promise<ApplyCompactionResult> {
  const preserveRecentTurns =
    opts.preserveRecentTurns ?? DEFAULT_COMPACTION_CONFIG.preserveRecentTurns;
  const byTokens = getCompactTailMode() === "tokens";

  // Check the real, provider-facing transcript for room to drop BEFORE paying
  // for a MemoryService summary. MemoryService tracks its own much smaller
  // shadow transcript (bounded per-call stubs, not the real tool output), so
  // it can keep finding a sliver to summarize — and report compacted:true —
  // long after the real session store has nothing left outside the last
  // `preserveRecentTurns` user turns (e.g. one long tool-heavy turn with no
  // new user message to advance the boundary). That false "compacted:true"
  // still busts the prompt cache and bills a real summarizer call for zero
  // actual reduction — confirmed as the cause of a 2026-10-30 session that
  // burned ~19.8M tokens of a subscription window in under an hour on 10
  // such no-op firings (see TODO.md). Skip the summary call entirely when
  // the store wouldn't shrink.
  const stored = await opts.store.getMessages(opts.sessionId, opts.projectPath);
  const preserve = byTokens
    ? keepRecentTokens(
        stored,
        opts.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
      )
    : keepLastNUserTurns(stored, preserveRecentTurns);
  if (preserve.length >= stored.length) {
    return {
      compacted: false,
      reason: "nothing to compact",
      tokensBefore: 0,
      tokensAfter: 0,
      messagesBefore: stored.length,
      messagesAfter: stored.length,
      compactedMessageIds: [],
      preservedMessageIds: preserve.map((message) => message.id),
    };
  }

  // One cut: the summary covers exactly what the store drops — everything
  // before the first kept message that follows the last dropped one (a pinned
  // prompt sits in front of the dropped run and does not count).
  const keptIds = new Set(preserve.map((message) => message.id));
  let lastDropped = -1;
  stored.forEach((message, i) => {
    if (!keptIds.has(message.id)) lastDropped = i;
  });
  const result = await opts.memory.compact({
    ...opts.compactOptions,
    ...(byTokens ? { cutoffTimestamp: stored[lastDropped + 1]?.timestamp } : {}),
  });
  if (!result.success || !result.summary) {
    return {
      compacted: false,
      reason: result.blocked
        ? (result.reason ?? "blocked by a PreCompact hook")
        : "nothing to compact",
      tokensBefore: result.tokenCountBefore,
      tokensAfter: result.tokenCountAfter,
      messagesBefore: 0,
      messagesAfter: 0,
      compactedMessageIds: [],
      preservedMessageIds: [],
    };
  }

  await opts.store.replaceMessages(opts.sessionId, preserve, opts.projectPath);

  markAllReadsCompacted(opts.sessionId);
  const preservedIds = new Set(preserve.map((message) => message.id));
  return {
    compacted: true,
    tokensBefore: result.tokenCountBefore,
    tokensAfter: result.tokenCountAfter,
    messagesBefore: stored.length,
    messagesAfter: preserve.length,
    compactedMessageIds: stored
      .filter((message) => !preservedIds.has(message.id))
      .map((message) => message.id),
    preservedMessageIds: preserve.map((message) => message.id),
  };
}
