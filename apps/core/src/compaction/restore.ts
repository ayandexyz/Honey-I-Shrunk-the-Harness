// =============================================================================
// Post-compaction file restore (spec 2026-10-13-stuck-loop-recovery.md §4.3).
//
// Compaction replaces every earlier read with a summary, so the model reloads
// the files it was working on: 94 of 102 rereads in the 2026-10-12 long-task
// run came right after a compaction. claude-code re-attaches the most recently
// read files instead (services/compact/compact.ts:122-124, 1415-1464); these
// are its numbers. Files still shown whole in the kept recent messages are
// skipped. The block rides the compaction summary's system block, which only
// changes at a compaction, so it adds no cache break of its own.
// =============================================================================

import * as fs from "node:fs";

export const RESTORE_MAX_FILES = 5;
// tools/read.ts DEFAULT_LIMIT and MAX_LINE_LENGTH: what a default read shows.
const READ_DEFAULT_LINES = 2000;
const READ_MAX_LINE = 2000;
/** ≈5K tokens at ~4 chars per token. */
export const RESTORE_FILE_CHARS = 20_000;
/** ≈50K tokens. */
export const RESTORE_TOTAL_CHARS = 200_000;

export interface RestoredFile {
  path: string;
  mtimeMs: number;
  size: number;
  /**
   * Shown whole, and exactly what a default `read` (offset 1, 2000 lines,
   * lines clipped at 2000 chars) would show — only then may a later read be
   * answered "unchanged" against it.
   */
  dedupSafe: boolean;
}

export interface RestoreBlock {
  text: string;
  files: RestoredFile[];
  chars: number;
}

/**
 * `recent` is most-recent first. Missing, binary and directory paths are
 * skipped silently: the block is a convenience, never a reason to fail.
 */
export function buildRestoreBlock(recent: string[], skip: Set<string>): RestoreBlock | undefined {
  const files: RestoredFile[] = [];
  const parts: string[] = [];
  let chars = 0;
  for (const p of recent) {
    if (files.length >= RESTORE_MAX_FILES || chars >= RESTORE_TOTAL_CHARS) break;
    if (skip.has(p)) continue;
    let stat: fs.Stats;
    let content: string;
    try {
      stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      const buf = fs.readFileSync(p);
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      content = buf.toString("utf-8");
    } catch {
      continue;
    }
    const room = Math.min(RESTORE_FILE_CHARS, RESTORE_TOTAL_CHARS - chars);
    const complete = content.length <= room;
    const shown = complete ? content : content.slice(0, room);
    parts.push(
      `<path>${p}</path>\n<content>\n${shown}${complete ? "" : `\n(truncated at ${room} characters — read it for the rest)`}\n</content>`,
    );
    chars += shown.length;
    const lines = content.split("\n");
    const dedupSafe =
      complete && lines.length <= READ_DEFAULT_LINES && lines.every((l) => l.length <= READ_MAX_LINE);
    files.push({ path: p, mtimeMs: stat.mtimeMs, size: stat.size, dedupSafe });
  }
  if (files.length === 0) return undefined;
  return {
    text:
      "Files you were working with, re-attached after compaction (their current content on disk — no need to read them again):\n\n" +
      parts.join("\n\n"),
    files,
    chars,
  };
}
