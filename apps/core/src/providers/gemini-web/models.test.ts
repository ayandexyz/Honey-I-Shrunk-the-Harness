import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL, resolveGeminiWebModel, warnOnModelFallback } from "./models.js";

test("a known model resolves to itself and reports no fallback", () => {
  const r = resolveGeminiWebModel("gemini-3.6-flash");
  assert.equal(r.name, "gemini-3.6-flash");
  assert.equal(r.fellBackFrom, undefined);
});

test("no model asked for is the default, not a fallback", () => {
  const r = resolveGeminiWebModel(undefined);
  assert.equal(r.name, DEFAULT_MODEL);
  assert.equal(r.fellBackFrom, undefined);
});

test("an unknown model still degrades to the default, and says so once", () => {
  const r = resolveGeminiWebModel("gemini-2.0-stale@think=1");
  assert.equal(r.name, DEFAULT_MODEL);
  assert.equal(r.think, 1, "a @think suffix is honoured on the fallback too");
  assert.equal(r.fellBackFrom, "gemini-2.0-stale");

  const warnings: string[] = [];
  warnOnModelFallback(r, (m) => warnings.push(m));
  warnOnModelFallback(resolveGeminiWebModel("gemini-2.0-stale"), (m) => warnings.push(m));
  assert.equal(warnings.length, 1, "once per id, not per request");
  assert.match(warnings[0]!, /Unknown model "gemini-2\.0-stale"; using/);

  warnOnModelFallback(resolveGeminiWebModel("gemini-3.6-flash"), (m) => warnings.push(m));
  assert.equal(warnings.length, 1, "a known model never warns");
});
