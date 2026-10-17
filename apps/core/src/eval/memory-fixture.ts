// =============================================================================
// Memory fixtures for eval cases (spec 2026-09-25 §6).
//
// A case with `memories` measures what automatic recall is worth, so its store
// must be exactly the fixture: seeded into the trial's own sandbox project
// (the store is keyed by project path, so a fresh tmpdir is a fresh store),
// frozen for the trial (extraction and consolidation off, or the two sides of
// a comparison would read different corpora), and removed afterwards. The
// developer's real store is never touched.
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "node:crypto";
import { MemoryStore, overrideMemoryDir } from "../memory/mem-store.js";
import {
  disposeProjectMemory,
  getMemoryGraphService,
} from "../memory/graph/index.js";
import type { MemoryEntry } from "../memory/mem-types.js";
import type { EvalCase, EvalMemory, EvalMemoryPolicy } from "./types.js";

export interface EvalMemoryIsolation {
  policy: EvalMemoryPolicy;
  fixture: string;
  cleanup(): void;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

/** Public report metadata: stable identity, never memory or transcript bodies. */
export function memoryPolicyForCase(
  kase: Pick<EvalCase, "memories" | "sessions">,
): Pick<EvalMemoryIsolation, "policy" | "fixture"> {
  if (kase.sessions) {
    return {
      policy: "learning",
      fixture: `learning-${fingerprint({ memories: kase.memories ?? [], sessions: kase.sessions })}`,
    };
  }
  if (kase.memories) {
    return {
      policy: "fixture",
      fixture: `fixture-${fingerprint(kase.memories)}`,
    };
  }
  return { policy: "empty", fixture: "empty-v1" };
}

/**
 * Point one trial at a fresh memory directory without changing its working
 * tree. This is what keeps read-only trajectory/judged cases grounded in the
 * real checkout while preventing recall from the developer's live corpus.
 */
export function isolateTrialMemory(
  projectPath: string,
  kase: Pick<EvalCase, "memories" | "sessions">,
): EvalMemoryIsolation {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-eval-memory-"));
  const restore = overrideMemoryDir(projectPath, path.join(root, "memory"));
  const metadata = memoryPolicyForCase(kase);
  let cleaned = false;
  return {
    ...metadata,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      // Dispose first: UsageStore.flush() and graph listeners still refer to
      // this directory. Then remove the Markdown corpus and every sidecar.
      disposeProjectMemory(projectPath);
      fs.rmSync(root, { recursive: true, force: true });
      restore();
    },
  };
}

/** How many memories `projectPath`'s store holds right now. */
export function countMemories(projectPath: string): number {
  return new MemoryStore(projectPath).list().length;
}

/**
 * Remove whatever `projectPath`'s store holds — for a multi-session case, what
 * the earlier sessions learned. The session and rollout logs stay.
 */
export function removeMemoryStore(projectPath: string): void {
  disposeProjectMemory(projectPath);
  fs.rmSync(new MemoryStore(projectPath).getMemoryDir(), {
    recursive: true,
    force: true,
  });
}

/** Env that freezes the corpus for the trial. Applied by the runner. */
export const FROZEN_MEMORY_ENV: Record<string, string> = {
  FREECODE_DISABLE_MEMORY_EXTRACTION: "1",
  FREECODE_DISABLE_MEMORY_CONSOLIDATION: "1",
};

/** Learning cases may extract; every other writer stays frozen by default. */
export function memoryEnvironmentForCase(
  kase: Pick<EvalCase, "sessions">,
): Record<string, string> {
  return kase.sessions
    ? { FREECODE_DISABLE_MEMORY_CONSOLIDATION: "1" }
    : FROZEN_MEMORY_ENV;
}

/**
 * Seed `memories` into `projectPath`'s store and build its retrieval index;
 * returns the cleanup.
 *
 * The index is built here, before the trial, because a real project already
 * has its `.graph/` sidecar on disk. A fresh store builds it on the first
 * retrieval, which overruns the 60 ms cold budget, so the first request of
 * every trial went out without memory — and many tasks settle their answer on
 * that request. Measured on the first smoke run (2026-09-25); unwarmed, the
 * suite would measure an artefact of the harness, not recall.
 */
export async function seedMemories(
  projectPath: string,
  memories: EvalMemory[],
): Promise<() => void> {
  const store = new MemoryStore(projectPath);
  const now = Date.now();
  for (const m of memories) {
    const entry: MemoryEntry = {
      type: m.type,
      name: m.name,
      description: m.description,
      content: m.content,
      createdAt: now,
      updatedAt: now,
      ...(m.tags ? { tags: m.tags } : {}),
      ...(m.supersedes ? { supersedes: m.supersedes } : {}),
    };
    store.save(entry);
  }
  await getMemoryGraphService(projectPath).retrieve("warm the index", {
    limit: 1,
  });
  // Only the memory directory: the session and rollout logs beside it are
  // what `freecode trace` reads when a red trial needs inspecting.
  return () => removeMemoryStore(projectPath);
}
