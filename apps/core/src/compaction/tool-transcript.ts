// =============================================================================
// Renders a turn's tool activity into the line format the compaction
// transcript and the heuristic summarizer already expect: `Tool <name>: …`.
//
// Before this, a tool-calling turn was recorded as the stub
// "[Executed N tools]" (agent/loop.ts). Every edit, command and error — the
// actual work of a coding session — was invisible to the summarizer, so the
// summary that replaced a hundred messages described only what was said
// about the work, never the work. It also left `extractToolCalls` and
// `extractFiles` in summarizer.ts matching nothing: two code paths that
// could not fire.
//
// Output is bounded twice: per tool call, and per turn. When the turn budget
// is exceeded the OLDEST lines go, not the newest — the tools that ran last
// are the ones the next turn needs. This module is the sole owner of that
// bound, which is why MemoryService no longer carries its own tool-output
// truncation: two truncators would have fought, and the outer one clipped
// the tail (the recent tools) rather than the head.
// =============================================================================

/**
 * Chars kept from each tool's result: pi's TOOL_RESULT_MAX_CHARS (opencode
 * keeps 1,250). At 200 a summary could name the files a session read but
 * not what was in them, so a session that only reads and greps re-read the
 * same code after every compaction (50f4745d / 8b4b7a32: two compactions
 * each, ~50 minutes of exploring, no edit and no answer before the end).
 */
const MAX_RESULT_CHARS = 2_000;
/** Chars kept from each tool's arguments — a path or a command, not a file. */
const MAX_ARGS_CHARS = 200;

export interface ToolActivity {
  tool: string;
  args?: unknown;
  /** The model-facing output, already capped by the orchestrator. */
  output?: string;
  /** Set when the call failed; reported in place of the output. */
  error?: string;
}

function clip(text: string, maxChars: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxChars
    ? oneLine
    : `${oneLine.slice(0, maxChars)}…`;
}

// `read`'s envelope. The path is already in the args, and at the old
// 200-char budget this was most of what survived of a file.
const READ_ENVELOPE = /^<path>[^\n]*<\/path>\n<type>\w+<\/type>\n(?:<content>\n)?/;

function stripEnvelope(output: string): string {
  return output.replace(READ_ENVELOPE, "").replace(/\n?<\/content>$/, "");
}

function renderArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    return clip(JSON.stringify(args), MAX_ARGS_CHARS);
  } catch {
    return "";
  }
}

/**
 * One line per tool call. Failures are marked so the summarizer's blocker
 * bucket can find them — an error is the single most important thing to
 * carry across a compaction boundary.
 */
export function renderToolActivity(
  activity: ToolActivity[],
  maxChars: number,
): string {
  const lines = activity
    .map((entry) => {
      const args = renderArgs(entry.args);
      const head = args ? `Tool ${entry.tool}: ${args}` : `Tool ${entry.tool}:`;
      if (entry.error) return `${head} -> failed: ${clip(entry.error, MAX_RESULT_CHARS)}`;
      if (!entry.output) return `${head} -> ok`;
      return `${head} -> ${clip(stripEnvelope(entry.output), MAX_RESULT_CHARS)}`;
    });

  let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  let dropped = 0;
  while (total > maxChars && lines.length > 1) {
    total -= lines.shift()!.length + 1;
    dropped++;
  }
  if (dropped > 0) {
    lines.unshift(`[${dropped} earlier tool calls omitted]`);
  }
  return lines.join("\n");
}

/**
 * The assistant memory entry for a turn: the model's own text (if any)
 * followed by what its tools actually did. Never the old stub.
 */
export function renderTurnForMemory(
  assistantText: string,
  activity: ToolActivity[],
  maxChars: number,
): string {
  const tools = renderToolActivity(activity, maxChars);
  if (!assistantText) return tools;
  if (!tools) return assistantText;
  return `${assistantText}\n${tools}`;
}

export const TOOL_TRANSCRIPT_LIMITS = Object.freeze({
  MAX_RESULT_CHARS,
  MAX_ARGS_CHARS,
});
