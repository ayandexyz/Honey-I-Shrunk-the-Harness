// =============================================================================
// Per-session edit totals: cumulative lines added and removed by the `edit`
// and `write` tools, in edit-stats.json beside the session's meta.json.
// Cumulative, not a net diff — a replaced line counts once each way, and
// editing the same line again counts again. bash, MCP and hand edits are not
// seen. Read by `session.list` so a frontend can show "+12 −3" per session.
// =============================================================================

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { diffLines } from "diff";
import { formatSessionDirName } from "../store/path-formatter.js";

export interface EditStats {
  added: number;
  removed: number;
}

const FILE = "edit-stats.json";

function sessionDir(sessionId: string, projectPath: string): string {
  return join(
    homedir(),
    ".freecode",
    "sessions",
    formatSessionDirName(projectPath),
    sessionId,
  );
}

const lineCount = (value: string) =>
  value.length === 0 ? 0 : value.split("\n").length - (value.endsWith("\n") ? 1 : 0);

export function countLineChanges(before: string, after: string): EditStats {
  const stats = { added: 0, removed: 0 };
  for (const part of diffLines(before, after)) {
    if (part.added) stats.added += part.count ?? lineCount(part.value);
    else if (part.removed) stats.removed += part.count ?? lineCount(part.value);
  }
  return stats;
}

function parse(raw: string): EditStats | undefined {
  try {
    const value = JSON.parse(raw) as Partial<EditStats>;
    if (typeof value.added !== "number" || typeof value.removed !== "number") {
      return undefined;
    }
    return { added: value.added, removed: value.removed };
  } catch {
    return undefined;
  }
}

/**
 * Add one successful edit's changes to the session's totals. Best-effort and
 * synchronous (the tools write files synchronously too, so two edits in one
 * process never interleave). A session with no directory — an unsaved or
 * sandboxed one — records nothing rather than creating one.
 */
export function recordEditStats(
  sessionId: string | undefined,
  projectPath: string,
  before: string,
  after: string,
): void {
  if (!sessionId) return;
  const delta = countLineChanges(before, after);
  if (delta.added === 0 && delta.removed === 0) return;
  const dir = sessionDir(sessionId, projectPath);
  if (!existsSync(dir)) return;
  const path = join(dir, FILE);
  try {
    const current = existsSync(path)
      ? (parse(readFileSync(path, "utf-8")) ?? { added: 0, removed: 0 })
      : { added: 0, removed: 0 };
    const tmp = `${path}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({
        added: current.added + delta.added,
        removed: current.removed + delta.removed,
      }),
      "utf-8",
    );
    renameSync(tmp, path);
  } catch {
    // Accounting must never fail the edit it describes.
  }
}

export async function readEditStats(
  sessionId: string,
  projectPath: string,
): Promise<EditStats | undefined> {
  try {
    return parse(await readFile(join(sessionDir(sessionId, projectPath), FILE), "utf-8"));
  } catch {
    return undefined;
  }
}
