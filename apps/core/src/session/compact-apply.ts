// Applies compaction so it persists across turns: MemoryService produces the
// summary (kept in the system prompt), and the session store is trimmed to the
// preserved recent turns so the NEXT turn's loadHistory() sends fewer messages.

import type { SessionStore, SerializedMessage } from "./store.js";
import type { MemoryService } from "../compaction/service.js";
import type { CompactOptions } from "../compaction/service.js";
import { DEFAULT_COMPACTION_CONFIG } from "../compaction/types.js";
import { markAllReadsCompacted } from "../tools/read-state.js";

export interface ApplyCompactionResult {
  compacted: boolean;
  reason?: string;
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
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
    if (messages[i].role === "user") {
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
  compactOptions?: CompactOptions;
}): Promise<ApplyCompactionResult> {
  const preserveRecentTurns =
    opts.preserveRecentTurns ?? DEFAULT_COMPACTION_CONFIG.preserveRecentTurns;

  const result = await opts.memory.compact(opts.compactOptions);
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
    };
  }

  const stored = await opts.store.getMessages(opts.sessionId, opts.projectPath);
  const preserve = keepLastNUserTurns(stored, preserveRecentTurns);
  if (preserve.length < stored.length) {
    await opts.store.replaceMessages(
      opts.sessionId,
      preserve,
      opts.projectPath,
    );
  }

  markAllReadsCompacted(opts.sessionId);
  return {
    compacted: true,
    tokensBefore: result.tokenCountBefore,
    tokensAfter: result.tokenCountAfter,
    messagesBefore: stored.length,
    messagesAfter: preserve.length,
  };
}
