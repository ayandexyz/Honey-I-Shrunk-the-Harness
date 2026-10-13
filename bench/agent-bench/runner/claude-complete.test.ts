import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { claudeComplete } from "./claude-complete.js";
import type { JudgeUsage } from "./core-complete.js";

const judge = { id: "judge-haiku", provider: "claude", model: "claude-haiku-4-5" };

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
