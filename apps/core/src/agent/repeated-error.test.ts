import test from "node:test";
import assert from "node:assert/strict";
import { commandFamily, createRepeatedErrors, errorLines, errorLocation } from "./repeated-error.js";

const TSC = "src/a.ts(3,1): error TS1110: Type expected.";
const tsc = "npx tsc --noEmit";

test("errorLines keeps located errors and test names, drops bare verdicts and TAP numbers", () => {
  const out = [TSC, "not ok 709 - every handler is declared", "grade: FAIL (verification)", "ok 1 - fine"].join("\n");
  assert.deepEqual(errorLines(out), [TSC, "not ok - every handler is declared"]);
});

test("commandFamily strips cd, redirects and the pipe filter", () => {
  assert.deepEqual(commandFamily("cd apps/core && npx tsc --noEmit 2>&1 | grep a.ts"), { family: tsc, filtered: true });
  assert.deepEqual(commandFamily(tsc), { family: tsc, filtered: false });
});

test("edited, same error back: counts once per edit, not per look", () => {
  const e = createRepeatedErrors();
  e.output(tsc, ""); // clean baseline
  for (let i = 0; i < 4; i++) {
    e.edit();
    e.output(tsc, TSC);
    e.output(`${tsc} | grep a.ts`, TSC); // re-reading the same result
  }
  assert.deepEqual(e.peak(), { max: 4, line: TSC });
});

test("errors present before the first edit, or in a command's first full run, are baseline", () => {
  const e = createRepeatedErrors();
  e.output(tsc, TSC);
  e.edit();
  e.output("pnpm test", "not ok 3 - offline");
  for (let i = 0; i < 5; i++) {
    e.edit();
    e.output(tsc, TSC);
    e.output("pnpm test", "not ok 3 - offline");
  }
  assert.equal(e.peak().max, 0);
});

test("a full run without the error clears its count; a filtered one does not", () => {
  const e = createRepeatedErrors();
  e.output(tsc, "");
  e.edit();
  e.output(tsc, TSC);
  e.edit();
  e.output(`${tsc} | grep other.ts`, ""); // filtered: says nothing about a.ts
  e.output(tsc, TSC);
  e.edit();
  e.output(tsc, ""); // fixed
  e.edit();
  e.output(tsc, TSC); // a new occurrence starts over
  assert.equal(e.peak().max, 2);
});

test("errorLocation reads tsc and path:line forms, and nothing from a test name", () => {
  assert.equal(errorLocation(TSC), "src/a.ts:3");
  assert.equal(errorLocation("src/b.ts:12:5 - error TS2345: x"), "src/b.ts:12");
  assert.equal(errorLocation("not ok - providers.list offers"), undefined);
});

test("current() is the live top line: it falls when the error clears, unlike peak()", () => {
  const e = createRepeatedErrors();
  e.output(tsc, "");
  for (let i = 0; i < 3; i++) {
    e.edit();
    e.output(tsc, `${TSC}\nsrc/b.ts(9,1): error TS1005: ';' expected.`);
  }
  assert.deepEqual(e.current(), { n: 3, line: TSC, others: 1 });
  e.edit();
  e.output(tsc, "");
  assert.equal(e.current().n, 0);
  assert.equal(e.peak().max, 3);
});

test("the evaluator warns on E at the threshold and never stops on it", async () => {
  const { createLoopHealthEvaluator } = await import("../effect/loop-health.js");
  const { DEFAULT_LOOP_HEURISTICS, createInitialSessionState } = await import("./types.js");
  const state = createInitialSessionState("s", "/p");
  const evaluate = (n: number) =>
    createLoopHealthEvaluator().evaluate(
      { ...state, loopHealth: { ...state.loopHealth, repeatedError: n } },
      DEFAULT_LOOP_HEURISTICS,
    );
  assert.equal(DEFAULT_LOOP_HEURISTICS.repeatedErrorThreshold, 5);
  assert.deepEqual(evaluate(4), { action: "continue" });
  assert.deepEqual(evaluate(5), { action: "warn", reason: "repeated_error" });
  assert.deepEqual(evaluate(50), { action: "warn", reason: "repeated_error" });
});
