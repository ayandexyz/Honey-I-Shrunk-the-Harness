// =============================================================================
// Shell command segments — split a bash command into the simple commands it
// runs, each with its verb at the front. Shared by the night envelope's deny
// rules (autonomous/envelope.ts) and the self-kill guard
// (permission/self-kill.ts), which both need to see a verb however it is
// chained, prefixed or path-qualified.
//
// Not a shell parser: quoting is ignored, so a separator inside a string
// splits there too. Both callers only refuse, so an extra split can only
// produce an extra match, never hide one.
// =============================================================================

/** `&&`, `||`, `;`, `|`, newline, and command substitution. */
export const SEGMENT_SPLIT = /\|\||&&|;|\||\n|`|\$\(|\)/;

/** `FOO=bar` — a leading environment assignment, not the command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Strip what a prefix rule cannot see past, so the verb lands at the front:
 * leading environment assignments and an `env` wrapper
 * (`GIT_AUTHOR_NAME=x env git commit` → `git commit`), then the directory of a
 * program path (`/usr/bin/git commit` → `git commit`).
 *
 * Only leading tokens are touched — a path or an `=` in an ARGUMENT is data,
 * and rewriting it would change which commands match.
 */
export function normalizeSegment(segment: string): string {
  let rest = segment.trim();
  for (;;) {
    const space = rest.search(/\s/);
    if (space === -1) break;
    const head = rest.slice(0, space);
    if (!ENV_ASSIGNMENT.test(head) && head !== "env") break;
    rest = rest.slice(space + 1).trimStart();
  }
  const space = rest.search(/\s/);
  const head = space === -1 ? rest : rest.slice(0, space);
  if (!head.includes("/")) return rest;
  const bare = head.slice(head.lastIndexOf("/") + 1);
  return space === -1 ? bare : bare + rest.slice(space);
}

/** Every non-empty segment of `command`, normalized. */
export function commandSegments(command: string): string[] {
  return command
    .split(SEGMENT_SPLIT)
    .map(normalizeSegment)
    .filter((segment) => segment.length > 0);
}
