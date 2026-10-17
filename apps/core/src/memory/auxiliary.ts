// =============================================================================
// Memory auxiliary-call accounting.
//
// Extraction, consolidation, and retrieval judging are real provider calls
// outside the foreground agent request. Their usage must remain separate from
// `model.response`: that response is the model turn the user waited for, while
// these calls can complete later or fail independently.
// =============================================================================

import type { ExecuteUsage } from "../providers/types.js";

export type MemoryAuxiliaryPurpose =
  | "retrieval_judge"
  | "extraction"
  | "consolidation"
  | "compaction"
  | "redirection"
  | "hook"
  | "final_flush";

export interface MemoryAuxiliaryCall {
  purpose: MemoryAuxiliaryPurpose;
  provider: string;
  model?: string;
  duration_ms: number;
  outcome: "succeeded" | "failed";
  usage?: ExecuteUsage;
}

export type MemoryAuxiliaryObserver = (call: MemoryAuxiliaryCall) => void;
