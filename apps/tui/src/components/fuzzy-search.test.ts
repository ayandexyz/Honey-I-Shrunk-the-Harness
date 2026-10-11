import test from "node:test";
import assert from "node:assert/strict";
import { ListSource } from "./menu-card.js";
import { SearchableSelectList } from "./searchable-select-list.js";
import stripAnsi from "strip-ansi";

const models = new ListSource("Models", [
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "gpt-5.5", label: "GPT-5.5", description: "OpenAI flagship" },
]);
const ids = (q: string) => models.search(q).map((r) => r.id);

test("a gapped query finds the model a substring search missed", () => {
  assert.deepEqual(ids("opus55"), ["claude-opus-5-5"]);
});

test("the closest match ranks first", () => {
  assert.equal(ids("haiku")[0], "claude-haiku-4-5");
  assert.equal(ids("gpt")[0], "gpt-5.5");
});

test("a description still matches by substring, after the fuzzy hits", () => {
  assert.deepEqual(ids("flagship"), ["gpt-5.5"]);
});

test("an empty query lists everything in order", () => {
  assert.deepEqual(ids(""), ["claude-haiku-4-5", "claude-opus-5-5", "gpt-5.5"]);
});

test("SearchableSelectList narrows by fuzzy query", () => {
  const theme = {
    selectedPrefix: (t: string) => t,
    selectedText: (t: string) => t,
    description: (t: string) => t,
    scrollInfo: (t: string) => t,
    noMatch: (t: string) => t,
  };
  const list = new SearchableSelectList(
    [
      { value: "github", label: "github" },
      { value: "filesystem", label: "filesystem" },
    ],
    5,
    theme,
  );
  for (const ch of "fsys") list.handleInput(ch);
  const shown = list.render(60).map(stripAnsi).join("\n");
  assert.match(shown, /filesystem/);
  assert.doesNotMatch(shown, /github/);
});
