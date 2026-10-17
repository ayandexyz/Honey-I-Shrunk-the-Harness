// =============================================================================
// Memory Prompt - Build memory context for system prompts
// =============================================================================

import type { MemoryEntry, MemoryType } from "./mem-types.js";
import { MemoryStore } from "./mem-store.js";

export interface MemoryPromptOptions {
  types?: MemoryType[];
  limit?: number;
  all?: boolean; // opt in to the full, unbounded store
}

// Default cap so a caller that forgets `limit` can't dump the whole store into a
// prompt. Pass `all: true` (or an explicit `limit`) to override.
const DEFAULT_PROMPT_LIMIT = 25;

// Build a memory block (optionally type-filtered / capped). This is NOT
// relevance-ranked — it lists memories in the store's natural order. For
// relevance-based retrieval use the graph service (`memory.query` /
// MemoryGraphService.retrieve); do not route relevance through here.
export function buildMemoryPrompt(
  store: MemoryStore,
  options: MemoryPromptOptions = {},
): string {
  const { types, limit, all } = options;

  let entries: MemoryEntry[] = store.list();
  if (types && types.length > 0) {
    entries = entries.filter((e) => types.includes(e.type));
  }
  const effectiveLimit = limit ?? (all ? undefined : DEFAULT_PROMPT_LIMIT);
  if (effectiveLimit != null) {
    entries = entries.slice(0, effectiveLimit);
  }

  if (entries.length === 0) {
    return "";
  }

  const lines: string[] = [
    "# Memory",
    "",
    `You have a persistent, file-based memory system at \`${store.getMemoryDir()}\`. This directory already exists — write to it directly (do not run mkdir).`,
    "",
    "## Types of memory",
    "- **user**: User's role, goals, preferences, knowledge",
    "- **feedback**: Guidance on what to avoid/repeat. Structure as: rule/fact, then **Why:** and **How to apply:** lines",
    "- **project**: Non-derivable context: deadlines, decisions, who's doing what",
    "- **reference**: External system pointers (Linear, Grafana, Slack)",
    "",
    "## What NOT to save in memory",
    "- Code patterns, git history, architecture (derivable from code)",
    "- Debugging solutions (the fix is in the code)",
    "- CLAUDE.md content, ephemeral task details",
    "",
    "## When to access memories",
    "- When memories seem relevant or user references prior work",
    "- MUST access when user asks to check/recall/remember",
    "- If user says *ignore* memory: treat MEMORY.md as empty",
    "",
    "## Before recommending from memory",
    "Verify file paths exist, grep for function/flag names before citing them",
    "",
    "---",
    "",
  ];

  // Group by type
  const byType = new Map<MemoryType, MemoryEntry[]>();
  for (const entry of entries) {
    const list = byType.get(entry.type) ?? [];
    list.push(entry);
    byType.set(entry.type, list);
  }

  for (const type of [
    "user",
    "feedback",
    "project",
    "reference",
    "episode",
  ] as MemoryType[]) {
    const typeEntries = byType.get(type) ?? [];
    if (typeEntries.length === 0) continue;

    lines.push(`## ${type.charAt(0).toUpperCase() + type.slice(1)}`);
    for (const entry of typeEntries) {
      lines.push("");
      lines.push(`### ${entry.name}`);
      lines.push(entry.content);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// How-to-use-memory guidance for the system prompt. Takes no arguments and
// returns constant text on purpose: it lives in the CACHED static prefix
// (context/compiler.ts), so making it depend on the store would rewrite the
// prefix on every save and bust the session's prompt cache. What memories
// *exist* is answered on demand by `memory(action: "list")`; what memories are
// *relevant* is injected per turn by renderRetrievedMemories below.
export function buildMemoryGuidanceBlock(): string {
  return [
    "# Memory",
    "",
    "You can remember things across sessions with the `memory` tool. Save when you",
    "learn something still true next week; skip anything this task's end makes stale.",
    "",
    "- **user** — who they are, how they like to work",
    "- **feedback** — guidance they gave you; add **Why:** and **How to apply:** lines",
    "- **project** — decisions, constraints, deadlines not derivable from the code",
    "- **reference** — pointers to external systems (dashboards, tickets, docs)",
    "",
    "Do not save what the repo already records — code structure, past fixes, git",
    "history, CLAUDE.md — or anything else derivable by reading the project.",
    "",
    "Link related memories with [[their-name]]. Saving an existing name updates it;",
    'use `memory(action: "list")` first if you are unsure one already covers it.',
    "Relevant memories are surfaced to you automatically — you rarely need to list.",
  ].join("\n");
}

// Hard ceiling on the injected block (spec D2). A count cap cannot see the
// failure mode that matters — one memory with a 4 KB body — and this block is
// injected uncached on every turn, so its size is paid every time.
export const MAX_MEMORY_BLOCK_BYTES = 2048;

const bytes = (s: string): number => Buffer.byteLength(s, "utf-8");

export interface RenderedMemories {
  /** The block appended to the request, or empty when nothing fits. */
  text: string;
  /** Exact entries represented in `text`, in retrieval relevance order. */
  entries: MemoryEntry[];
  /** Entries rendered with their full body. */
  fullCount: number;
  /** Entries degraded to a one-line summary (every episode is one). */
  summaryCount: number;
}

function promptHeader(): string[] {
  // Measurement escape hatch (same pattern as FREECODE_EPHEMERAL_TAIL):
  // `FREECODE_MEMORY_PROMPT=legacy` reverts to the pre-2026-09-07 header so
  // `eval ab` can price the two wordings side by side. Re-read every call —
  // the ab runner flips it per side after boot.
  return process.env.FREECODE_MEMORY_PROMPT === "legacy"
    ? [
        "# Relevant memories",
        "",
        "Memories surfaced as relevant to the current request (verify before relying on them):",
      ]
    : [
        "# Relevant memories",
        "",
        "Background recall; it may be stale. Verify claims about current code. Apply",
        "user and project requirements unless the current request supersedes them;",
        "stale or incomplete code does not override a remembered requirement.",
        "Combine compatible memories and preserve every named case and unit. The",
        "current request overrides past turn-local directions such as 'just acknowledge'",
        "or 'do not edit yet'.",
        "Do NOT narrate, restate, or re-acknowledge these in your visible replies:",
        "this block repeats on every request, so reacting to it each time floods the",
        "transcript. Act on it silently; mention a memory only if the user asks.",
      ];
}

const CITATION_FOOTER = [
  "",
  "If any of the above shaped your answer, end your reply with:",
  "<memory-used>type/name, type/name</memory-used>",
];

function renderBlock(
  entries: MemoryEntry[],
  full: ReadonlySet<MemoryEntry>,
  summaries: ReadonlySet<MemoryEntry>,
): string {
  const byType = new Map<MemoryType, MemoryEntry[]>();
  for (const entry of entries) {
    if (!full.has(entry) && !summaries.has(entry)) continue;
    const list = byType.get(entry.type) ?? [];
    list.push(entry);
    byType.set(entry.type, list);
  }
  if (byType.size === 0) return "";

  const lines = [...promptHeader()];
  for (const type of [
    "user",
    "feedback",
    "project",
    "reference",
  ] as MemoryType[]) {
    const typeEntries = byType.get(type) ?? [];
    if (typeEntries.length === 0) continue;

    lines.push("", `## ${type.charAt(0).toUpperCase() + type.slice(1)}`);
    for (const entry of typeEntries) {
      if (full.has(entry)) {
        lines.push("", `### ${entry.name}`, entry.content);
      } else {
        lines.push(`- ${entry.name} — ${entry.description}`);
      }
    }
  }

  const episodes = (byType.get("episode") ?? [])
    .slice()
    .sort((a, b) => (b.happened_at ?? "").localeCompare(a.happened_at ?? ""));
  if (episodes.length > 0) {
    lines.push("", "## Episode");
    for (const entry of episodes) {
      // The name is the citation identity (`episode/<name>`), same shape as
      // the other types' summary lines; without it an episode that shaped an
      // answer could never be credited.
      lines.push(
        `- ${entry.name} (${entry.happened_at ?? "undated"}) — ${entry.description}`,
      );
    }
  }

  lines.push(...CITATION_FOOTER);
  return lines.join("\n");
}

// Lean per-turn block for memories the graph service surfaced as relevant to
// the current context. Kept compact (no full usage preamble) since it is
// injected every turn; the "how to use memory" guidance lives elsewhere.
//
// Entries are rendered in the order given, which is cascade-score order
// (`retrieveScored`). Once the byte budget is spent, the remainder degrade to a
// one-line `- name — description`, and past that they are dropped: a weakly
// relevant memory is worth its description even when it is not worth its body.
export function renderRetrievedMemoriesDetailed(
  entries: MemoryEntry[],
): RenderedMemories {
  if (entries.length === 0) {
    return { text: "", entries: [], fullCount: 0, summaryCount: 0 };
  }

  // Try entries in retrieval relevance order and validate each prospective
  // block as a whole. This accounts for all section headings, separators, and
  // the citation footer instead of approximating their byte cost.
  const full = new Set<MemoryEntry>();
  const summaries = new Set<MemoryEntry>();
  for (const entry of entries) {
    const preferFull = entry.type !== "episode";
    if (preferFull) {
      full.add(entry);
      if (
        bytes(renderBlock(entries, full, summaries)) <= MAX_MEMORY_BLOCK_BYTES
      )
        continue;
      full.delete(entry);
    }

    summaries.add(entry);
    if (bytes(renderBlock(entries, full, summaries)) <= MAX_MEMORY_BLOCK_BYTES)
      continue;
    summaries.delete(entry);
  }

  const text = renderBlock(entries, full, summaries);
  return {
    text,
    entries: entries.filter((entry) => full.has(entry) || summaries.has(entry)),
    fullCount: full.size,
    summaryCount: summaries.size,
  };
}

/** Backward-compatible string API for callers that do not need attribution. */
export function renderRetrievedMemories(entries: MemoryEntry[]): string {
  return renderRetrievedMemoriesDetailed(entries).text;
}
