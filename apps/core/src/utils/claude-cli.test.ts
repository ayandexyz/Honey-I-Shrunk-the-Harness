import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claudeCliArgs, parseClaudeCliResult, runClaudeCli } from "./claude-cli.js";

test("args pin the model, put the system prompt in the system slot, and strip the owner's setup", () => {
  const a = claudeCliArgs("claude-haiku-4-5", "SYS");
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(a[0], "-p");
  assert.equal(after("--model"), "claude-haiku-4-5");
  assert.equal(after("--system-prompt"), "SYS");
  assert.equal(after("--output-format"), "json");
  assert.equal(after("--setting-sources"), "", "no user/project settings: no hooks, plugins");
  assert.equal(after("--tools"), "", "a judge has no tools");
  for (const f of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"]) {
    assert.ok(a.includes(f), f);
  }
  assert.ok(!a.includes("--bare"), "--bare never reads the subscription login");
  assert.ok(!a.includes("--json-schema"), "plain text unless a schema is asked for");
  const s = claudeCliArgs("m", "S", { type: "object" });
  assert.deepEqual(JSON.parse(s[s.indexOf("--json-schema") + 1]!), { type: "object" });
});

test("parse: plain text from `result`, JSON from `structured_output`, cached input counted", () => {
  const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7 };
  const plain = parseClaudeCliResult(JSON.stringify({ is_error: false, result: "SCORE: 4\nWHY: fine", usage }), false);
  assert.equal(plain.text, "SCORE: 4\nWHY: fine");
  assert.equal(plain.inputTokens, 115);
  assert.equal(plain.outputTokens, 7);
  const structured = parseClaudeCliResult(JSON.stringify({ result: "ignored", structured_output: { a: 1 }, usage }), true);
  assert.equal(structured.text, '{"a":1}');
  assert.throws(() => parseClaudeCliResult(JSON.stringify({ is_error: true, result: "rate limited" }), false), /rate limited/);
  assert.throws(() => parseClaudeCliResult(JSON.stringify({ result: "prose" }), true), /no reply/);
});

test("runClaudeCli sends the prompt on stdin and rejects a failed exit with stderr", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-cli-"));
  const bin = path.join(dir, "claude");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (input === "fail") { process.stderr.write("not logged in"); process.exit(1); }
  console.log(JSON.stringify({ result: "got " + input.length, usage: { input_tokens: 1, output_tokens: 1 } }));
});
`,
  );
  fs.chmodSync(bin, 0o755);
  const signal = new AbortController().signal;
  const big = "x".repeat(200_000);
  assert.equal((await runClaudeCli({ model: "m", system: "s", prompt: big, signal, bin })).text, "got 200000");
  await assert.rejects(runClaudeCli({ model: "m", system: "s", prompt: "fail", signal, bin }), /exited 1: not logged in/);
});
