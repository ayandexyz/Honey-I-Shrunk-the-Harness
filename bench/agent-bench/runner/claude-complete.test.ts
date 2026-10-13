import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { claudeArgs, claudeComplete, parseClaudeResult } from "./claude-complete.js";
import type { JudgeUsage } from "./core-complete.js";

const judge = { id: "judge-haiku", provider: "claude", model: "claude-haiku-4-5" };
const verdict = { analysis: "a", strengths: [], weaknesses: [], completionScore: 7, codeQualityScore: 6, overallScore: 7 };

test("claudeArgs pins the model, puts the system prompt in the system slot, and strips the owner's setup", () => {
  const a = claudeArgs("claude-haiku-4-5", "SYS");
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(a[0], "-p");
  assert.equal(after("--model"), "claude-haiku-4-5");
  assert.equal(after("--system-prompt"), "SYS");
  assert.equal(after("--output-format"), "json");
  assert.deepEqual(JSON.parse(after("--json-schema")).required.at(-1), "overallScore");
  assert.equal(after("--setting-sources"), "", "no user/project settings: no hooks, plugins");
  assert.equal(after("--tools"), "", "a judge has no tools");
  for (const f of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) {
    assert.ok(a.includes(f), f);
  }
  assert.ok(!a.includes("--bare"), "--bare never reads the subscription login");
});

test("parseClaudeResult returns structured_output and counts cached input as input", () => {
  const r = parseClaudeResult(
    JSON.stringify({
      is_error: false,
      result: "ignored",
      structured_output: verdict,
      usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 },
    }),
  );
  assert.deepEqual(JSON.parse(r.text), verdict);
  assert.equal(r.inputTokens, 115);
  assert.equal(r.outputTokens, 7);
  assert.throws(() => parseClaudeResult(JSON.stringify({ is_error: true, result: "rate limited" })), /rate limited/);
  assert.throws(() => parseClaudeResult(JSON.stringify({ is_error: false, result: "prose" })), /no verdict/);
});

// A fake `claude` that behaves like the real one in -p mode: reads the prompt
// from stdin (it would hang if stdin stayed open) and prints one JSON result.
function fakeClaude(script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(bin, `#!/usr/bin/env node\n${script}\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("claudeComplete sends the prompt on stdin and returns the verdict with usage", async () => {
  const bin = fakeClaude(`
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const sys = process.argv[process.argv.indexOf("--system-prompt") + 1];
  console.log(JSON.stringify({
    is_error: false,
    structured_output: { analysis: sys + "|" + input, strengths: [], weaknesses: [], completionScore: 1, codeQualityScore: 1, overallScore: 1 },
    usage: { input_tokens: 3, output_tokens: 2 },
  }));
});`);
  const usage: JudgeUsage = {};
  const out = await claudeComplete(usage, bin)(judge, "SYS", "x".repeat(200_000), new AbortController().signal);
  assert.equal(JSON.parse(out).analysis, `SYS|${"x".repeat(200_000)}`, "a prompt over argv's 128KB cap arrives whole");
  assert.deepEqual(usage["judge-haiku"], { inputTokens: 3, outputTokens: 2, calls: 1 });
});

test("claudeComplete rejects on a non-zero exit with stderr", async () => {
  const bin = fakeClaude(`process.stderr.write("not logged in"); process.exit(1);`);
  await assert.rejects(
    claudeComplete({}, bin)(judge, "S", "p", new AbortController().signal),
    /exited 1: not logged in/,
  );
});
