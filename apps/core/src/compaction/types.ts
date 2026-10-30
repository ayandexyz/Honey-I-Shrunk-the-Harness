export type MemoryRole = "system" | "user" | "assistant";

export interface MemoryMessage {
  id: string;
  role: MemoryRole;
  content: string;
  timestamp: number;
  tokenCount: number;
}

export interface CompactionSummary {
  id: string;
  createdAt: number;
  originalMessageCount: number;
  originalTokenCount: number;
  summaryTokenCount: number;
  content: string;
}

export interface MemoryState {
  sessionId: string;
  messages: MemoryMessage[];
  summaries: CompactionSummary[];
  tokenCount: number;
  totalCompactions: number;
  lastCompactionAt?: number;
}

export interface CompactionConfig {
  autoCompactBufferTokens: number;
  preserveRecentTurns: number;
  maxPreserveRecentTokens: number;
  /**
   * Total chars of tool transcript kept for one turn (tool-transcript.ts).
   * Sized for a turn, not a single output: at ~450 chars per tool line this
   * carries roughly a dozen calls, and drops the oldest first when it can't.
   */
  maxToolOutputChars: number;
  /**
   * Ceiling on the first user message kept verbatim as the founding brief
   * (see selectForCompaction). A head larger than this is a pasted document,
   * not an instruction, and is summarized like anything else.
   */
  maxPreserveHeadTokens: number;
  /**
   * Cooldown, in `shouldCompact()` calls (one per turn), after a successful
   * compaction before another is allowed to start — independent of token
   * growth. Second line of defense alongside the real-store feasibility
   * check in `session/compact-apply.ts` (2026-10-30 thrashing incident: 10
   * no-op compactions fired within ~5 minutes, each busting the prompt
   * cache for nothing). jcode's `min_turns_between_compactions` (default 10)
   * is the model, but jcode only applies it to its predictive proactive/
   * semantic triggers; freecode's trigger is reactive (fires once the
   * measured/estimated tokens actually cross the threshold), so a long
   * cooldown risks holding back a genuinely overflowing session. Kept small.
   */
  minTurnsBetweenCompactions: number;
}

export interface SelectionResult {
  summarize: MemoryMessage[];
  preserve: MemoryMessage[];
  summarizeTokenCount: number;
  preserveTokenCount: number;
}

export interface CompactionResult {
  success: boolean;
  blocked?: boolean;
  reason?: string;
  summary?: CompactionSummary;
  preservedMessageIds: string[];
  compactedMessageIds: string[];
  tokenCountBefore: number;
  tokenCountAfter: number;
}

export interface PromptMemoryContext {
  summary?: string;
  recentMessages: MemoryMessage[];
  tokenCount: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  autoCompactBufferTokens: 13_000,
  preserveRecentTurns: 2,
  maxPreserveRecentTokens: 8_000,
  maxToolOutputChars: 4_000,
  maxPreserveHeadTokens: 2_000,
  // Small, deliberately: jcode's equivalent default is 10, but jcode only
  // applies its cooldown to a predictive trigger that fires ahead of real
  // need. freecode's trigger is reactive, so a long hold risks a genuinely
  // overflowing session never getting to compact.
  minTurnsBetweenCompactions: 2,
};
