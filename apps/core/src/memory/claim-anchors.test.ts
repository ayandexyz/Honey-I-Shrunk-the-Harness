import test from "node:test";
import assert from "node:assert/strict";
import { anchorClaims, uncoveredClaims } from "./claim-anchors.js";

test("numbers, paths, flags, acronyms and proper nouns are claims", () => {
  assert.deepEqual(
    anchorClaims(
      "Deploy v0.46.1 from docs/release.md with --isolate on Fridays",
    ),
    ["v0.46.1", "docs/release.md", "--isolate", "fridays"],
  );
});

test("ordinary prose has no claims to check", () => {
  assert.deepEqual(anchorClaims("we always deploy on friday afternoons"), []);
});

test("a hyphenated adjective is not a claim", () => {
  assert.deepEqual(anchorClaims("the store is single-machine only"), []);
});

test("a replacement that carries every claim covers its source", () => {
  assert.deepEqual(
    uncoveredClaims(
      "The thread store is a single SQLite file",
      "The thread store is a single SQLite file. Deploys happen on Fridays.",
    ),
    [],
  );
});

test("a replacement about something else leaves the claims uncovered", () => {
  assert.deepEqual(
    uncoveredClaims(
      "The thread store is a single SQLite file",
      "Deploys happen on Fridays.",
    ),
    ["sqlite"],
  );
});

test("rewording around a claim still covers it", () => {
  assert.deepEqual(
    uncoveredClaims(
      "We always deploy on Fridays",
      "Deploys happen on Fridays.",
    ),
    [],
  );
});

test("a specific value replaced by a newer one reads as uncovered", () => {
  // The fail-safe direction: a merge that swaps Nov 3 for Dec 1 keeps its
  // sources and reports the skip. Updating a value is the extraction path's
  // job, where new information is allowed to land.
  assert.deepEqual(
    uncoveredClaims(
      "The campaign deadline is Nov 3",
      "The campaign deadline moved to Dec 1",
    ),
    ["nov", "3"],
  );
});
