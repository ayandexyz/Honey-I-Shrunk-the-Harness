import test from "node:test";
import assert from "node:assert/strict";
import { contentWords, isSubtractive } from "./claim-subset.js";

const words = (text: string): string[] => contentWords(text).sort();

test("content words keep claims, drop function words", () => {
  // "never" and "not" are claims about behaviour, not filler: dropping them
  // would make "never run npm install" and "run npm install" the same memory.
  assert.deepEqual(words("The store is not a never-ending log"), [
    "endin",
    "log",
    "never",
    "not",
    "store",
  ]);
});

test("inflection alone is not a new claim", () => {
  assert.deepEqual(
    words("We always deploy on Fridays"),
    words("We always deploys on Friday"),
  );
});

test("a rewrite that only subtracts claims is subtractive", () => {
  assert.equal(
    isSubtractive(
      "We always deploy on Fridays and never on Mondays",
      "We always deploy on Fridays",
    ),
    true,
    "dropping the Monday rule while adding nothing is exactly the silent loss",
  );
});

test("a rewrite that adds a claim is not subtractive", () => {
  assert.equal(
    isSubtractive(
      "We always deploy on Fridays",
      "We always deploy on Fridays, and never on Mondays",
    ),
    false,
    "new information arriving is an update, not a loss",
  );
});

test("a rewrite that carries over the claims in new words is not subtractive", () => {
  assert.equal(
    isSubtractive(
      "The campaign deadline is Nov 3",
      "The campaign deadline moved to Dec 1",
    ),
    false,
    "one specific value replacing another is a newer fact, not a lost one",
  );
});

test("a rewrite that keeps every claim is not subtractive", () => {
  assert.equal(
    isSubtractive("We always deploy on Fridays", "We always deploy on Fridays"),
    false,
  );
});
