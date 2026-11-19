// =============================================================================
// The summarizer's input, from the messages a compaction actually drops.
// Spec 2026-11-19-compaction-token-tail §5.1.
//
// Before this the summary was written from MemoryService's shadow transcript,
// lined up with the store by timestamp: a parallel batch, a transcript rebuilt
// on branch switch, or anything the loop never mirrored there could make the
// summary cover something other than what was dropped. Claude Code, pi and
// opencode all summarize the real messages; this renders them in the line
// format the summarizers already read (tool-transcript.ts), bounded the same
// way the shadow was.
// =============================================================================

import type { SerializedMessage } from "../session/store.js";
import { estimateTokenCount } from "./tokens.js";
import { renderTurnForMemory, type ToolActivity } from "./tool-transcript.js";
import type { MemoryMessage } from "./types.js";

function renderUser(message: SerializedMessage): string {
  return message.parts
    .map((part) =>
      part.type === "image" ? "[image]" : (part.content ?? ""),
    )
    .filter(Boolean)
    .join("\n");
}

function renderAssistant(
  message: SerializedMessage,
  maxToolOutputChars: number,
): string {
  const text = message.parts
    .filter((part) => part.type === "text" || part.type === "code")
    .map((part) => part.content ?? "")
    .filter(Boolean)
    .join("\n");
  const activity: ToolActivity[] = message.parts
    .filter((part) => part.type === "tool" && part.tool)
    .map((part) => ({
      tool: part.tool!.name,
      args: part.tool!.args,
      output: part.result,
    }));
  return renderTurnForMemory(text, activity, maxToolOutputChars);
}

/**
 * One memory message per stored message. Appended context (recalls, todo
 * state) is skipped: it is the harness's per-turn state, re-sent as it
 * changes, not history to summarize.
 */
export function storeToMemoryMessages(
  messages: SerializedMessage[],
  maxToolOutputChars: number,
): MemoryMessage[] {
  const out: MemoryMessage[] = [];
  for (const message of messages) {
    if (message.synthetic === "context") continue;
    const content =
      message.role === "user"
        ? renderUser(message)
        : renderAssistant(message, maxToolOutputChars);
    if (!content) continue;
    out.push({
      id: message.id,
      role: message.role,
      content,
      timestamp: message.timestamp,
      tokenCount: estimateTokenCount(content),
    });
  }
  return out;
}
