// =============================================================================
// JSON Thread Store - File-based fallback for SQLite
// PRIMARY: Persist thread data to JSON files when SQLite is unavailable
// STORAGE: ~/.freecode/state/threads/{threadId}.json
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type {
  ThreadStore,
  StoredThread,
  ThreadFilter,
  JsonThreadStore,
} from "./types.js";
import { logger } from "../utils/logger.js";

// ============================================================================
// Constants
// ============================================================================

const STORE_DIR = ".freecode";
const STATE_DIR = "state";
const THREADS_DIR = "threads";
const METADATA_FILE = "store.json";

// ============================================================================
// Helpers
// ============================================================================

function getStoreDir(): string {
  return path.join(os.homedir(), STORE_DIR, STATE_DIR, THREADS_DIR);
}

function getMetadataPath(): string {
  return path.join(os.homedir(), STORE_DIR, STATE_DIR, METADATA_FILE);
}

function ensureDir(): void {
  const dir = getStoreDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readMetadata(): JsonThreadStore {
  const metaPath = getMetadataPath();
  try {
    if (fs.existsSync(metaPath)) {
      const content = fs.readFileSync(metaPath, "utf-8");
      return JSON.parse(content);
    }
  } catch (error) {
    logger.warn(`[JsonThreadStore] Failed to read metadata: ${error}`);
  }
  return {
    threads: {},
    metadata: { version: 1, lastUpdated: Date.now() },
  };
}

function writeMetadata(store: JsonThreadStore): void {
  ensureDir();
  const metaPath = getMetadataPath();
  fs.writeFileSync(metaPath, JSON.stringify(store, null, 2));
}

function getThreadPath(threadId: string): string {
  return path.join(getStoreDir(), `${threadId}.json`);
}

// ============================================================================
// JsonThreadStore Implementation
// ============================================================================

export class JsonThreadStoreImpl implements ThreadStore {
  private store: JsonThreadStore;

  constructor() {
    this.store = readMetadata();
  }

  // ===========================================================================
  // Thread CRUD
  // ===========================================================================

  async createThread(
    thread: Omit<StoredThread, "id" | "createdAt" | "updatedAt">,
  ): Promise<string> {
    const id = `thread-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();

    const fullThread: StoredThread = {
      ...thread,
      id,
      createdAt: now,
      updatedAt: now,
    };

    this.store.threads[id] = fullThread;
    this.store.metadata.lastUpdated = now;
    writeMetadata(this.store);

    return id;
  }

  async getThread(threadId: string): Promise<StoredThread | null> {
    return this.store.threads[threadId] || null;
  }

  async updateThread(
    threadId: string,
    updates: Partial<StoredThread>,
  ): Promise<void> {
    const thread = this.store.threads[threadId];
    if (!thread) return;

    this.store.threads[threadId] = {
      ...thread,
      ...updates,
      id: threadId, // Preserve ID
      updatedAt: Date.now(),
    };
    this.store.metadata.lastUpdated = Date.now();
    writeMetadata(this.store);
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.updateThread(threadId, { status: "archived" });
  }

  async deleteThread(threadId: string): Promise<void> {
    delete this.store.threads[threadId];
    this.store.metadata.lastUpdated = Date.now();
    writeMetadata(this.store);

    // Also delete the individual thread file if it exists
    const filePath = getThreadPath(threadId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  async listThreads(filter?: ThreadFilter): Promise<StoredThread[]> {
    let threads = Object.values(this.store.threads);

    if (filter?.status) {
      threads = threads.filter((t) => t.status === filter.status);
    }
    if (filter?.projectPath) {
      threads = threads.filter((t) => t.projectPath === filter.projectPath);
    }
    if (filter?.provider) {
      threads = threads.filter((t) => t.provider === filter.provider);
    }

    // Sort by lastTurnAt descending
    threads.sort((a, b) => b.lastTurnAt - a.lastTurnAt);

    // Apply pagination
    if (filter?.offset) {
      threads = threads.slice(filter.offset);
    }
    if (filter?.limit) {
      threads = threads.slice(0, filter.limit);
    }

    return threads;
  }

  async searchThreads(query: string): Promise<StoredThread[]> {
    const q = query.toLowerCase();
    return Object.values(this.store.threads).filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.projectPath.toLowerCase().includes(q) ||
        (t.goal && t.goal.toLowerCase().includes(q)),
    );
  }

  // ===========================================================================
  // Utility
  // ===========================================================================

  async close(): Promise<void> {
    // No-op for JSON store - data is already persisted
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createJsonThreadStore(): JsonThreadStoreImpl {
  return new JsonThreadStoreImpl();
}
