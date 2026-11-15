// =============================================================================
// Thread Store Types - Session persistence for FreeCode
// PRIMARY: Define types for thread storage and filtering
// STORAGE: SQLite primary with JSON file fallback
// =============================================================================

// ============================================================================
// Thread State Machine
// ============================================================================

export type ThreadStatus = "active" | "archived" | "deleted";

export type ThreadGoalStatus = "pending" | "active" | "completed" | "failed";

// ============================================================================
// StoredThread - Full thread data stored in database
// ============================================================================

export interface StoredThread {
  // Identity
  id: string;
  title: string;

  // Metadata
  createdAt: number;
  updatedAt: number;
  lastTurnAt: number;
  status: ThreadStatus;

  // Context
  projectPath: string;
  provider: string;

  // State
  turnCount: number;
  iterationCount: number;

  // Goal tracking
  goal?: string;
  goalStatus?: ThreadGoalStatus;
  goalUpdatedAt?: number;
}

// ============================================================================
// ThreadFilter - Filter options for listing/searching threads
// ============================================================================

export interface ThreadFilter {
  status?: ThreadStatus;
  projectPath?: string;
  provider?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// ThreadStore Interface - Abstract persistence layer
// ============================================================================

export interface ThreadStore {
  // Thread CRUD
  createThread(
    thread: Omit<StoredThread, "id" | "createdAt" | "updatedAt">,
  ): Promise<string>;
  getThread(threadId: string): Promise<StoredThread | null>;
  updateThread(threadId: string, updates: Partial<StoredThread>): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  listThreads(filter?: ThreadFilter): Promise<StoredThread[]>;
  searchThreads(query: string): Promise<StoredThread[]>;

  // Utility
  close(): Promise<void>;
}

// ============================================================================
// JSON Store Types - For JSON file fallback
// ============================================================================

export interface JsonThreadStore {
  threads: Record<string, StoredThread>;
  metadata: {
    version: number;
    lastUpdated: number;
  };
}
