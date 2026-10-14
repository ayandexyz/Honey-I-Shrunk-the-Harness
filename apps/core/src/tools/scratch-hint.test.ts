import test from "node:test";
import assert from "node:assert/strict";
import { SCRATCH_HINT, scratchScriptHint } from "./scratch-hint.js";
import { errorLines } from "../agent/repeated-error.js";

const MISSING = "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'strip-ansi' imported from /tmp/render-logo.mjs";

test("a /tmp script that cannot find a module gets the hint", () => {
  // The shapes seen in recorded sessions: heredoc then run, cd then run, tsx.
  for (const cmd of [
    "cat > /tmp/probe.mjs << 'EOF'\nimport x from 'strip-ansi'\nEOF\nnode /tmp/probe.mjs",
    "cd /repo/apps/core && node /tmp/render-logo.mjs",
    "npx tsx /tmp/debug.ts 2>&1 | head",
  ]) {
    assert.equal(scratchScriptHint(cmd, MISSING), SCRATCH_HINT, cmd);
  }
});

test("no hint for a script inside the project, another error, or a /tmp file that is not run", () => {
  assert.equal(scratchScriptHint("node ./scratch/probe.mjs", MISSING), "");
  assert.equal(scratchScriptHint("node /tmp/probe.mjs", "TypeError: x is not a function"), "");
  assert.equal(scratchScriptHint("cat /tmp/build.log", "Cannot find module 'x'"), "");
  // Already moved into the project, then run from there (recorded session b79f94dc).
  assert.equal(scratchScriptHint("cp /tmp/t.mjs /repo/t.mjs && cd /repo && node t.mjs", MISSING), "");
});

test("a project that itself lives in /tmp (an eval sandbox) is not a scratch dir", () => {
  const cwd = "/tmp/freecode-eval-K7xPoD";
  assert.equal(scratchScriptHint(`node --import ${cwd}/preload.mjs check.mjs`, MISSING, cwd), "");
  assert.equal(scratchScriptHint("node /tmp/other/probe.mjs", MISSING, cwd), SCRATCH_HINT);
});

test("the hint itself is not an error line, so signal E never counts it", () => {
  assert.deepEqual(errorLines(SCRATCH_HINT), []);
});
