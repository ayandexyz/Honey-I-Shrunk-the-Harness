// =============================================================================
// Rollout Replay - Reconstruct state from events
// PRIMARY: Rebuild session state by replaying event log
// =============================================================================

import type {
  RolloutEvent,
  FunctionCallEvent,
  FunctionOutputEvent,
  TurnStartedEvent,
} from "./types.js";
import type { SessionEvents } from "./history.js";
import { loadSessionEvents } from "./history.js";

// ============================================================================
// Replay State Types
// ============================================================================

export interface ReplayedTurn {
  turnId: string;
  startedAt: number;
  calls: Array<{
    tool: string;
    args: Record<string, unknown>;
    output?: string;
    duration_ms?: number;
  }>;
}

export interface ReplayResult {
  sessionId: string;
  totalTurns: number;
  totalCalls: number;
  totalEstimatedTranscriptTokensBefore: number;
  totalEstimatedTranscriptTokensAfter: number;
  /** @deprecated Local transcript estimate; use the explicit field above. */
  totalTokensBefore: number;
  /** @deprecated Local transcript estimate; use the explicit field above. */
  totalTokensAfter: number;
  turns: ReplayedTurn[];
  compactCount: number;
  errors: string[];
}

/**
 * Replay events and reconstruct session state
 */
export function replaySession(sessionId: string): ReplayResult | null {
  const session = loadSessionEvents(sessionId);
  if (!session) return null;

  const result: ReplayResult = {
    sessionId,
    totalTurns: 0,
    totalCalls: 0,
    totalEstimatedTranscriptTokensBefore: 0,
    totalEstimatedTranscriptTokensAfter: 0,
    totalTokensBefore: 0,
    totalTokensAfter: 0,
    turns: [],
    compactCount: 0,
    errors: [],
  };

  // Group events by turn
  const turnMap = new Map<string, ReplayedTurn>();
  const turnOrder: string[] = [];

  for (const event of session.events) {
    switch (event.type) {
      case "turn.started": {
        const typedEvent = event as TurnStartedEvent;
        const turn: ReplayedTurn = {
          turnId: typedEvent.turnId,
          startedAt: typedEvent.timestamp,
          calls: [],
        };
        turnMap.set(typedEvent.turnId, turn);
        turnOrder.push(typedEvent.turnId);
        result.totalTurns++;
        break;
      }

      case "function.call": {
        const typedEvent = event as FunctionCallEvent;
        const turn = turnMap.get(typedEvent.turnId);
        if (turn) {
          turn.calls.push({
            tool: typedEvent.tool,
            args: typedEvent.args,
          });
          result.totalCalls++;
        }
        break;
      }

      case "function.output": {
        const typedEvent = event as FunctionOutputEvent;
        // Attach to the first pending call for this tool in its own turn
        const turn = turnMap.get(typedEvent.turnId);
        const call = turn?.calls.find(
          (c) => c.tool === typedEvent.tool && c.output === undefined,
        );
        if (call) {
          call.output = typedEvent.output;
          call.duration_ms = typedEvent.duration_ms;
        }
        break;
      }

      case "compact.occurred": {
        const estimatedBefore =
          event.estimatedTranscriptTokensBefore ?? event.beforeTokens ?? 0;
        const estimatedAfter =
          event.estimatedTranscriptTokensAfter ?? event.afterTokens ?? 0;
        result.totalEstimatedTranscriptTokensBefore += estimatedBefore;
        result.totalEstimatedTranscriptTokensAfter += estimatedAfter;
        result.totalTokensBefore += estimatedBefore;
        result.totalTokensAfter += estimatedAfter;
        result.compactCount++;
        break;
      }

      case "parse.error": {
        result.errors.push(`${(event as any).parser}: ${(event as any).error}`);
        break;
      }
    }
  }

  // Build ordered turn list
  for (const turnId of turnOrder) {
    const turn = turnMap.get(turnId);
    if (turn) result.turns.push(turn);
  }

  return result;
}

/**
 * Get a summary of what happened in a session
 */
export function getSessionSummary(sessionId: string): string | null {
  const replay = replaySession(sessionId);
  if (!replay) return null;

  const lines = [
    `Session: ${sessionId}`,
    `Turns: ${replay.totalTurns}`,
    `Tool Calls: ${replay.totalCalls}`,
    `Compactions: ${replay.compactCount}`,
    "",
  ];

  if (replay.errors.length > 0) {
    lines.push(`Errors (${replay.errors.length}):`);
    for (const err of replay.errors.slice(0, 5)) {
      lines.push(`  - ${err}`);
    }
    if (replay.errors.length > 5) {
      lines.push(`  ... and ${replay.errors.length - 5} more`);
    }
    lines.push("");
  }

  if (replay.turns.length > 0) {
    lines.push("Last turn tools:");
    const lastTurn = replay.turns[replay.turns.length - 1];
    for (const call of lastTurn.calls.slice(0, 5)) {
      lines.push(`  - ${call.tool}`);
    }
  }

  return lines.join("\n");
}

/**
 * Replay with compact information
 */
export interface CompactInfo {
  estimatedTranscriptTokensBefore?: number;
  estimatedTranscriptTokensAfter?: number;
  /** @deprecated Local transcript estimate; use the explicit field above. */
  beforeTokens?: number;
  /** @deprecated Local transcript estimate; use the explicit field above. */
  afterTokens?: number;
  providerRequestTokensBefore?: number;
  messagesBefore?: number;
  messagesAfter?: number;
  compactedMessageIds: string[];
  preservedMessageIds: string[];
  timestamp: number;
}

/**
 * Get all compactions that occurred in a session
 */
export function getCompactions(session: SessionEvents): CompactInfo[] {
  const compactions: CompactInfo[] = [];

  for (const event of session.events) {
    if (event.type === "compact.occurred") {
      const estimatedTranscriptTokensBefore =
        event.estimatedTranscriptTokensBefore ?? event.beforeTokens;
      const estimatedTranscriptTokensAfter =
        event.estimatedTranscriptTokensAfter ?? event.afterTokens;
      compactions.push({
        estimatedTranscriptTokensBefore,
        estimatedTranscriptTokensAfter,
        beforeTokens: estimatedTranscriptTokensBefore,
        afterTokens: estimatedTranscriptTokensAfter,
        providerRequestTokensBefore: event.providerRequestTokensBefore,
        messagesBefore: event.messagesBefore,
        messagesAfter: event.messagesAfter,
        compactedMessageIds: event.compactedMessageIds ?? [],
        preservedMessageIds: event.preservedMessageIds ?? [],
        timestamp: event.timestamp,
      });
    }
  }

  return compactions;
}
