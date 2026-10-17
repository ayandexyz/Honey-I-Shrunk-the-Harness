// =============================================================================
// Anchor claims — what a replacement must carry before a merge may delete.
//
// Plan 2026-10-15 §5 Phase 2: a merge may not delete a memory whose durable
// claims the replacement does not carry, and uncertainty keeps the source.
//
// "Every content word" would be the wrong reading of "claims": a merge that
// rewords or summarises would be refused for losing a verb, and consolidation —
// the only thing bounding the store — would stop running. So the check is on
// the tokens that cannot be paraphrased away: the values a memory is actually
// about. A source with none of them has nothing specific to lose and merges
// unchecked; that trade is deliberate, and Phase 3 measures it.
// =============================================================================

/** A `--flag`, or an ordinary word / path / identifier token. */
const TOKEN = /--[A-Za-z0-9][A-Za-z0-9_-]*|[A-Za-z0-9][A-Za-z0-9_@/.#:]*/g;

/** Marks that make a token an identifier rather than prose. */
const IDENTIFIER_MARK = /[_@/.#:]/;

/** Ends a sentence, so the next capital letter is ordinary grammar. */
const SENTENCE_END = /[.!?;:\n\-*•)]$/;

/** Punctuation that ends a token but is not part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?)"'\]]+$/;

function startsSentence(text: string, index: number): boolean {
  const before = text.slice(0, index).replace(/\s+$/, "");
  return before.length === 0 || SENTENCE_END.test(before);
}

/**
 * The claims a replacement has to carry verbatim: numbers, dates and versions;
 * paths, addresses and identifiers; `--flags`; acronyms; and proper nouns
 * (capitalised mid-sentence, so "SQLite" counts and sentence-initial "The"
 * does not). Lowercased and deduped, in first-seen order.
 */
export function anchorClaims(text: string): string[] {
  const claims: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(TOKEN)) {
    // A sentence-final period is punctuation, not part of the token: "Fridays."
    // and "Fridays" are the same claim, or every claim at the end of a
    // sentence would read as uncovered.
    const token = match[0].replace(TRAILING_PUNCTUATION, "");
    const specific =
      /\d/.test(token) ||
      IDENTIFIER_MARK.test(token) ||
      token.startsWith("--") ||
      /^[A-Z]{2,}$/.test(token) ||
      (/^[A-Z]/.test(token) && !startsSentence(text, match.index ?? 0));
    if (!specific) continue;
    const claim = token.toLowerCase();
    if (seen.has(claim)) continue;
    seen.add(claim);
    claims.push(claim);
  }
  return claims;
}

/** The claims of `source` that `replacement` does not carry. */
export function uncoveredClaims(source: string, replacement: string): string[] {
  const carried = new Set(anchorClaims(replacement));
  return anchorClaims(source).filter((claim) => !carried.has(claim));
}
