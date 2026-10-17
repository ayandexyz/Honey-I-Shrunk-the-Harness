// =============================================================================
// Subtractive rewrites — the one silent loss a same-name save can cause.
//
// Memory is idempotent on `(type, name)`: a later write that reuses a name
// updates the entry (docs/MEMORY_SYSTEM.md). That contract stays — it is how a
// fact gets corrected. What must not happen is a rewrite carrying *less* than
// the entry already holds while bringing nothing in its place: an extractor
// reusing a topic name for a narrower fact would erase the rest of it.
//
// The test is about *adding*, never about wording. Any rewrite that introduces
// a claim of its own is an update, however it is phrased, and passes untouched
// — so a corrected fact ("Nov 3" -> "Dec 1") is never mistaken for a loss.
// =============================================================================

/**
 * Words that carry no claim on their own. Negations (`not`, `never`, `no`) are
 * deliberately absent: they change what a memory means.
 */
const FUNCTION_WORDS = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "both",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "done",
  "each",
  "every",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "may",
  "me",
  "might",
  "more",
  "most",
  "much",
  "must",
  "my",
  "of",
  "on",
  "or",
  "our",
  "out",
  "over",
  "own",
  "shall",
  "she",
  "should",
  "so",
  "some",
  "such",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "under",
  "up",
  "us",
  "very",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

/**
 * Claim-bearing words: lowercased, function words dropped, crudely stemmed by
 * truncating to five characters so "deploys"/"deploy" and "Fridays"/"Friday"
 * read as one claim instead of two. Digits count — a date or a port is a claim.
 */
export function contentWords(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (FUNCTION_WORDS.has(word)) continue;
    const stem = word.slice(0, 5);
    if (seen.has(stem)) continue;
    seen.add(stem);
    out.push(stem);
  }
  return out;
}

/**
 * True when `replacement` carries fewer claims than `source` and brings none of
 * its own — a strict subset of what is already stored, which is a silent loss
 * rather than an update.
 */
export function isSubtractive(source: string, replacement: string): boolean {
  const stored = contentWords(source);
  const kept = new Set(stored);
  const incoming = contentWords(replacement);
  if (incoming.some((word) => !kept.has(word))) return false;
  const written = new Set(incoming);
  return stored.some((word) => !written.has(word));
}
