// =============================================================================
// Edit-time diagnostics (spec 2026-10-14-edit-time-diagnostics.md §1.2).
// Claude Code's delivery: the edit never waits — the errors it introduced ride
// the NEXT model request as a reminder. A file's first push, if it came before
// any edit, is the baseline: errors that were already there are never shown,
// and each new one is shown once.
// =============================================================================

import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { diagnosticPushes, openFile, syncFile, type DiagnosticPush } from "./client.js";

const MAX_WAIT_MS = 1_500;
const POLL_MS = 100;
const MAX_PER_FILE = 10;
const MAX_TOTAL = 30;

interface SessionDiagnostics {
  roots: Set<string>;
  /** uri → error message → count, from the file's first push before any edit. */
  baseline: Map<string, Map<string, number>>;
  /** uri → messages already shown since the file's last edit. */
  reported: Map<string, Set<string>>;
  lastSeq: Map<string, number>;
  edited: Set<string>;
  /** Edited, and no push since. */
  awaiting: Set<string>;
  syncing: Promise<unknown>[];
}

// ponytail: never pruned — a few small maps per session, fine for a daemon's life
const sessions = new Map<string, SessionDiagnostics>();

/** Read per call so `eval ab` can flip it per side. */
export function editDiagnosticsEnabled(): boolean {
  return process.env.FREECODE_EDIT_DIAGNOSTICS === "1";
}

function stateFor(sessionId: string): SessionDiagnostics {
  let st = sessions.get(sessionId);
  if (!st) {
    st = { roots: new Set(), baseline: new Map(), reported: new Map(), lastSeq: new Map(), edited: new Set(), awaiting: new Set(), syncing: [] };
    sessions.set(sessionId, st);
  }
  return st;
}

/** A file was read: open it so its first push becomes the baseline. */
export function noteRead(sessionId: string | undefined, file: string, root: string): void {
  if (!sessionId || !editDiagnosticsEnabled()) return;
  stateFor(sessionId).roots.add(root);
  openFile(file, root).catch(() => {});
}

/** A file was written: tell its server, and wait for the result at the next drain. */
export function noteEdit(sessionId: string | undefined, file: string, root: string): void {
  if (!sessionId || !editDiagnosticsEnabled()) return;
  const st = stateFor(sessionId);
  const uri = pathToFileURL(file).href;
  st.roots.add(root);
  st.edited.add(uri);
  st.reported.delete(uri); // still broken after another edit → say so again
  st.syncing.push(
    syncFile(file, root).then(
      (synced) => synced && st.awaiting.add(uri),
      () => {},
    ),
  );
}

const isError = (d: { severity?: number }) => (d.severity ?? 1) === 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Delivered {
  text: string;
  files: number;
  errors: number;
  waitedMs: number;
}

/** New errors since the last drain, as a reminder; undefined when there are none. */
export async function drainEditDiagnostics(sessionId: string): Promise<Delivered | undefined> {
  const st = sessions.get(sessionId);
  if (!st) return undefined;
  const started = Date.now();
  const deadline = started + MAX_WAIT_MS;

  // A cold server can take seconds to initialize; the sync waits on that.
  const syncing = st.syncing.splice(0);
  await Promise.race([Promise.allSettled(syncing), sleep(MAX_WAIT_MS)]);

  const pushes = () => [...st.roots].flatMap((r) => diagnosticPushes(r));
  const fresh = (p: DiagnosticPush) => p.seq > (st.lastSeq.get(p.uri) ?? 0);
  let current = pushes();
  while (st.awaiting.size > 0 && Date.now() < deadline) {
    for (const p of current) if (fresh(p)) st.awaiting.delete(p.uri);
    if (st.awaiting.size === 0) break;
    await sleep(POLL_MS);
    current = pushes();
  }

  const report: { file: string; lines: string[]; more: number }[] = [];
  let total = 0;
  for (const p of current) {
    if (!fresh(p)) continue;
    st.lastSeq.set(p.uri, p.seq);
    st.awaiting.delete(p.uri);
    const errors = p.diagnostics.filter(isError);
    if (!st.baseline.has(p.uri)) {
      const baseline = new Map<string, number>();
      // What was broken before this session touched the file. A file edited
      // before its first push has no baseline: everything in it is reported.
      if (!st.edited.has(p.uri))
        for (const e of errors) baseline.set(e.message, (baseline.get(e.message) ?? 0) + 1);
      st.baseline.set(p.uri, baseline);
      if (!st.edited.has(p.uri)) continue;
    }
    // Keyed by message, not position: an edit above an old error moves it.
    const baseline = st.baseline.get(p.uri)!;
    const reported = st.reported.get(p.uri) ?? new Set<string>();
    st.reported.set(p.uri, reported);
    const counts = new Map<string, number>();
    const added = errors.filter((e) => {
      const n = (counts.get(e.message) ?? 0) + 1;
      counts.set(e.message, n);
      return n > (baseline.get(e.message) ?? 0) && !reported.has(e.message);
    });
    for (const e of added) reported.add(e.message);
    if (added.length === 0) continue;
    const shown = added.slice(0, Math.min(MAX_PER_FILE, MAX_TOTAL - total));
    total += shown.length;
    report.push({
      file: relativeTo(st.roots, fileURLToPath(p.uri)),
      lines: shown.map((e) => `  ERROR ${e.range.start.line + 1}:${e.range.start.character + 1} ${e.message}`),
      more: added.length - shown.length,
    });
    if (total >= MAX_TOTAL) break;
  }
  if (report.length === 0) return undefined;

  const body = report
    .map((r) => [r.file, ...r.lines, ...(r.more > 0 ? [`  … and ${r.more} more`] : [])].join("\n"))
    .join("\n");
  return {
    text: `<new-diagnostics>\nYour edits introduced these errors:\n${body}\n</new-diagnostics>`,
    files: report.length,
    errors: total,
    waitedMs: Date.now() - started,
  };
}

function relativeTo(roots: Set<string>, file: string): string {
  for (const r of roots) if (file.startsWith(r + path.sep)) return path.relative(r, file);
  return file;
}
