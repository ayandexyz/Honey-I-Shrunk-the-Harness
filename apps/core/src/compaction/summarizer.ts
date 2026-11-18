import type { CompactionSummary, MemoryMessage } from "./types.js";
import { estimateTokenCount } from "./tokens.js";

export interface SummarizeInput {
  sessionId: string;
  previousSummary?: string;
  messages: MemoryMessage[];
  /**
   * The founding request when the selector kept it verbatim (the head
   * carve-out), so it is not among `messages`. Without it the heuristic Goal
   * fell back to "Continue the current coding session".
   */
  goal?: string;
}

/**
 * Wrap summary content (from either the heuristic or an LLM) into a
 * CompactionSummary, computing the token bookkeeping consistently.
 */
export function makeSummary(
  input: SummarizeInput,
  content: string,
): CompactionSummary {
  const originalTokenCount = input.messages.reduce(
    (sum, message) => sum + message.tokenCount,
    0,
  );
  return {
    id: `summary-${input.sessionId}-${Date.now()}`,
    createdAt: Date.now(),
    originalMessageCount: input.messages.length,
    originalTokenCount,
    summaryTokenCount: estimateTokenCount(content),
    content,
  };
}

function clip(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

/**
 * Extract file paths from message content. Trailing `</path>` envelopes and
 * grep's `:12:` / `-12-` line markers are not part of the path.
 */
function extractFiles(messages: MemoryMessage[]): Set<string> {
  const files = new Set<string>();
  for (const message of messages) {
    for (const match of message.content.matchAll(
      /(?:apps|packages|docs)\/[^\s)`'"<>]+/g,
    )) {
      files.add(match[0].replace(/[-:]\d+[-:]?$/, "").replace(/\/$/, ""));
    }
  }
  return files;
}

/** A transcript line recording a tool call (tool-transcript.ts's format). */
const TOOL_LINE = /^(?:Tool \w+:|\[\d+ earlier tool calls omitted\])/;

function proseLines(messages: MemoryMessage[]): string[] {
  return messages.flatMap((m) =>
    m.role === "assistant"
      ? m.content.split("\n").filter((l) => l.trim() && !TOOL_LINE.test(l))
      : [],
  );
}

function toolLines(messages: MemoryMessage[]): string[] {
  return messages.flatMap((m) =>
    m.content.split("\n").filter((l) => /^Tool \w+:/.test(l)),
  );
}

/**
 * Classify the model's own prose into at most one status bucket each.
 * Priority: blocked > in progress > done — a line like "no errors, all done"
 * must not land in two buckets, and blockers matter most after compaction.
 * Tool lines are not prose: a read of code that mentions "error" is not a
 * blocker. A tool call that failed is, so those go to Blocked as they are.
 */
function extractWorkStatus(messages: MemoryMessage[]): {
  done: string[];
  inProgress: string[];
  blocked: string[];
} {
  const done: string[] = [];
  const inProgress: string[] = [];
  const blocked: string[] = [];
  const add = (bucket: string[], line: string) => {
    const item = clip(line, 200);
    if (!bucket.includes(item)) bucket.push(item);
  };

  for (const line of toolLines(messages)) {
    if (line.includes(" -> failed: ")) add(blocked, line);
  }
  for (const line of proseLines(messages)) {
    const content = line.toLowerCase();
    // Word-boundary match so "error handling" doesn't count as a blocker,
    // and negations ("no error", "without errors") are excluded.
    const isBlocked =
      /\b(blocked|waiting|errors?|failed|failing)\b/.test(content) &&
      !/\b(no|without|zero|resolved|fixed)\s+(errors?|blockers?|issues?)\b/.test(
        content,
      );
    if (isBlocked) add(blocked, line);
    else if (/working on|in progress|currently/.test(content)) add(inProgress, line);
    else if (/completed|done|finished/.test(content)) add(done, line);
  }

  // The newest blockers are the ones still likely to be open.
  return { done, inProgress, blocked: blocked.slice(-5) };
}

/**
 * Extract tool names that were called
 */
function extractToolCalls(messages: MemoryMessage[]): string[] {
  const tools = new Set<string>();
  for (const msg of messages) {
    for (const match of msg.content.matchAll(/Tool (\w+):/g)) {
      tools.add(match[1]);
    }
  }
  return [...tools];
}

export function summarizeMessages(input: SummarizeInput): CompactionSummary {
  const userMessages = input.messages.filter(
    (message) => message.role === "user",
  );
  const assistantMessages = input.messages.filter(
    (message) => message.role === "assistant",
  );
  const files = extractFiles(input.messages);
  const workStatus = extractWorkStatus(input.messages);
  const toolCalls = extractToolCalls(input.messages);

  // Build structured summary
  const lines: string[] = [];

  // Goal section
  lines.push("## Goal");
  lines.push(
    `- ${clip(userMessages[0]?.content ?? input.goal ?? "Continue the current coding session.", 500)}`,
  );

  // Previous summary for continuity
  if (input.previousSummary) {
    lines.push("");
    lines.push("## Previous Summary");
    lines.push(clip(input.previousSummary, 1_500));
  }

  // Done section - what was completed
  lines.push("");
  lines.push("## Done");
  if (workStatus.done.length > 0) {
    for (const item of workStatus.done.slice(0, 5)) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push("- (none)");
  }

  // In Progress section
  lines.push("");
  lines.push("## In Progress");
  if (workStatus.inProgress.length > 0) {
    for (const item of workStatus.inProgress.slice(0, 3)) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push("- (none)");
  }

  // Blocked section
  lines.push("");
  lines.push("## Blocked");
  if (workStatus.blocked.length > 0) {
    for (const item of workStatus.blocked.slice(-3)) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push("- (none)");
  }

  // Decisions section - tools that were called indicate decisions made
  lines.push("");
  lines.push("## Decisions");
  if (toolCalls.length > 0) {
    lines.push(`- Tools used: ${toolCalls.join(", ")}`);
    lines.push("- (see Recent Findings for what they returned)");
  } else {
    lines.push("- (none)");
  }

  // Recent Progress section - the model's own last words
  lines.push("");
  lines.push("## Recent Progress");
  const prose = proseLines(input.messages);
  if (prose.length > 0) {
    for (const line of prose.slice(-3)) lines.push(`- ${clip(line, 300)}`);
  } else {
    lines.push("- (none)");
  }

  // Recent Findings section - what the last tool calls actually returned, so
  // a session that only reads and greps does not lose all of it.
  lines.push("");
  lines.push("## Recent Findings");
  const findings = toolLines(input.messages).filter(
    (line) => !line.includes(" -> failed: "),
  );
  if (findings.length > 0) {
    for (const line of findings.slice(-8)) lines.push(`- ${clip(line, 500)}`);
  } else {
    lines.push("- (none)");
  }

  // Relevant Files section
  lines.push("");
  lines.push("## Relevant Files");
  const fileList = [...files].slice(0, 15);
  if (fileList.length > 0) {
    for (const file of fileList) {
      lines.push(`- ${file}`);
    }
  } else {
    lines.push("- (none)");
  }

  // Next Steps section
  lines.push("");
  lines.push("## Next Steps");
  lines.push(
    `- This summary replaces ${input.messages.length} older messages that were compacted away`,
  );
  if (assistantMessages.length > 0) {
    lines.push("- Continue from where the session left off");
  }

  return makeSummary(input, lines.join("\n"));
}
