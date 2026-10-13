import test from "node:test";
import assert from "node:assert/strict";
import { parseVerdict, verifierFailureReminder } from "./subagent.js";
import { buildVerifierTask } from "./subagent.js";

test("parseVerdict reads an explicit verdict line (case-insensitive)", () => {
  assert.equal(parseVerdict("findings...\nVERDICT: PASS"), "PASS");
  assert.equal(parseVerdict("VERDICT: fail"), "FAIL");
  assert.equal(parseVerdict("blah\nVerdict:   Partial\n"), "PARTIAL");
});

test("parseVerdict defaults to PARTIAL when no verdict is present", () => {
  // Never a false PASS on garbled/missing output.
  assert.equal(parseVerdict("the code looks fine to me"), "PARTIAL");
  assert.equal(parseVerdict(""), "PARTIAL");
});

test("verifierFailureReminder wraps the report in a system-reminder", () => {
  const r = verifierFailureReminder("missing null check in foo.ts");
  assert.match(r, /<system-reminder>/);
  assert.match(r, /returned FAIL/);
  assert.match(r, /missing null check in foo\.ts/);
});


test("the verifier is told what the tests said, what nothing calls, and to trace from an entry point", () => {
  const task = buildVerifierTask({
    originalRequest: "Add agent_send",
    changedFiles: ["src/agent/registry.ts"],
    testResult: "failed: not ok 709 - every implemented handler is declared",
    unwired: [{ name: "attachLoop", file: "src/agent/registry.ts", line: 40 }],
  });
  assert.match(task, /Tests run before finishing: failed: not ok 709/);
  assert.match(task, /attachLoop \(src\/agent\/registry\.ts:40\)/);
  assert.match(task, /trace it from a\s+user entry point/);
  assert.match(task, /written and never read, or built and never called\s+from a real path, is FAIL/);
  assert.match(task, /VERDICT: PASS \| FAIL \| PARTIAL/);
  // Without the new inputs the old contract is unchanged.
  assert.doesNotMatch(buildVerifierTask({ originalRequest: "x", changedFiles: ["a"] }), /Tests run before finishing/);
});
