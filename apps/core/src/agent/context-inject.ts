// =============================================================================
// Append-only delivery of per-turn context (memory recall, todo list,
// <system-reminder>s) — how Claude Code (attachment messages) and opencode
// (synthetic messages) do it.
//
// The ephemeral tail rebuilt this text at the end of EVERY request and dropped
// it from the next. Anthropic caches past that (explicit breakpoints sit before
// it), but the ChatGPT backend froze its cache at the first request's size for
// the rest of the turn — measured 2026-10-19: 36,608 cached of 38K/40K/41K with
// a tail, 36,608/37,632/39,808 without. Appending once, as a persisted message,
// only grows the prefix, so every provider's cache extends.
//
// Only what is NEW is appended: memory and todos when they differ from what was
// last delivered, reminders always (they are already one-shot). The loop resets
// `DeliveredContext` after compaction, which may have trimmed the earlier copies.
// =============================================================================

import type { Message } from "./types.js";

const OPEN = "<system-reminder>";
const CLOSE = "</system-reminder>";

/** What this loop has already put into the persisted conversation. */
export interface DeliveredContext {
  memory?: string;
  todos?: string;
}

export interface ContextBlocks {
  memoryBlock: string;
  todoBlock: string;
  reminderText: string;
}

export interface ContextToAppend {
  /** The message text, or undefined when nothing is new. */
  text?: string;
  /** Whether this append carries the memory block (for `memory.exposure`). */
  memory: boolean;
  delivered: DeliveredContext;
}

/**
 * On by default since 2026-10-20; `FREECODE_APPEND_CONTEXT=0` restores the
 * per-request tail. Read per request so `eval ab` can flip it. Measured (luna,
 * memory suite): cached 84% → 93%, uncached −62%, model time −18%; coding
 * suites with an empty store pass unchanged at ~5% more tokens (both models).
 */
export function appendContextEnabled(): boolean {
  return process.env.FREECODE_APPEND_CONTEXT !== "0";
}

function wrap(block: string): string {
  return block.startsWith(OPEN) ? block : `${OPEN}\n${block}\n${CLOSE}`;
}

export function contextToAppend(
  delivered: DeliveredContext,
  blocks: ContextBlocks,
): ContextToAppend {
  const parts: string[] = [];
  const memory =
    blocks.memoryBlock.length > 0 && blocks.memoryBlock !== delivered.memory;
  if (memory) parts.push(wrap(blocks.memoryBlock));
  // An emptied list appends nothing — the todowrite result already said so —
  // but is remembered, so the same list coming back is delivered again.
  if (blocks.todoBlock.length > 0 && blocks.todoBlock !== delivered.todos) {
    parts.push(wrap(blocks.todoBlock));
  }
  if (blocks.reminderText.length > 0) parts.push(wrap(blocks.reminderText));
  return {
    text: parts.length > 0 ? parts.join("\n\n") : undefined,
    memory,
    delivered: {
      memory: blocks.memoryBlock.length > 0 ? blocks.memoryBlock : delivered.memory,
      todos: blocks.todoBlock,
    },
  };
}

/**
 * A context message is the harness talking, not the user: it must not be read
 * as the last request, mined for memories, or counted as a user turn. Claude
 * Code uses the same prefix as its discriminator.
 */
export function isContextText(text: string): boolean {
  return text.startsWith(OPEN);
}

/**
 * The context one provider request newly delivers, in either mode: the tail,
 * or the context messages appended since the last turn (they trail the
 * request). For observers — tests and traces assert on what the model was
 * told, not on which mechanism told it.
 */
export function newlyDelivered(request: {
  messages?: Message[];
  ephemeralTail?: string;
}): string {
  if (request.ephemeralTail) return request.ephemeralTail;
  const appended: string[] = [];
  const messages = request.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") break;
    const text = m.parts
      .map((p) => (p.type === "text" ? p.content : ""))
      .join("");
    if (!isContextText(text)) break;
    appended.unshift(text);
  }
  return appended.join("\n\n");
}
