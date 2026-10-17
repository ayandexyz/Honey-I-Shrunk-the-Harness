import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { opencodeArgs, opencodeComplete, opencodeText } from "./opencode-complete.js";
import type { JudgeUsage } from "./core-complete.js";

const judge = { id: "judge-deepseek", provider: "opencode", model: "deepseek-v4.1-flash-free" };

test("opencodeArgs runs the model OpenCode serves, with machine-readable events", () => {
  assert.deepEqual(opencodeArgs("opencode/deepseek-v4.1-flash-free"), [
    "run",
    "-m",
    "opencode/deepseek-v4.1-flash-free",
    "--format",
    "json",
  ]);
});

test("opencodeText concatenates the reply's text parts and ignores every other event", () => {
  const jsonl = [
    '{"type":"step_start","part":{"type":"step-start"}}',
    '{"type":"text","part":{"type":"text","text":"{\\"analysis\\":"}}',
    '{"type":"text","part":{"type":"text","text":"\\"ok\\"}"}}',
    '{"type":"tool","part":{"type":"tool","state":{"output":"text that is not the reply"}}}',
    "not json",
    "",
  ].join("\n");
  assert.equal(opencodeText(jsonl), '{"analysis":"ok"}');
  assert.equal(opencodeText(""), "");
});

// A fake `opencode` that behaves like the real one in `run --format json`: it
// reads the message from stdin (it would hang if stdin stayed open) and prints
// JSONL events. `-m` is expanded so a fake can see what it was asked to run.
function fakeOpencode(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-opencode-"));
  const bin = path.join(dir, "opencode");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const model = process.argv[process.argv.indexOf("-m") + 1];
${body}
`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("opencodeComplete pipes the judge prompt on stdin, in an empty dir, and returns the CLI's text", async () => {
  const bin = fakeOpencode(`
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "step_start", part: { type: "step-start" } }));
  console.log(JSON.stringify({
    type: "text",
    part: {
      type: "text",
      text: JSON.stringify({
        model,
        head: input.slice(0, 3),
        tail: input.slice(-3),
        bytes: input.length,
        dirFiles: require("fs").readdirSync(".").length,
      }),
    },
  }));
});`);
  const usage: JudgeUsage = {};
  const text = await opencodeComplete(usage, bin)(
    judge,
    "SYS",
    "x".repeat(300_000) + "END",
    new AbortController().signal,
  );
  const got = JSON.parse(text);
  assert.equal(got.model, "opencode/deepseek-v4.1-flash-free", "the judge's model reaches opencode's -m");
  assert.equal(got.head, "SYS", "the system prompt leads the message");
  assert.equal(got.tail, "END", "a prompt over argv's 128KB cap arrives whole, through stdin");
  assert.ok(got.bytes > 300_000);
  assert.equal(got.dirFiles, 0, "a judge reads nothing from disk");
  assert.deepEqual(usage["judge-deepseek"], { inputTokens: 0, outputTokens: 0, calls: 1 });
});

test("opencodeComplete rejects on a non-zero exit, with stderr in the reason", async () => {
  const bin = fakeOpencode(`console.error("free tier rate limited"); process.exit(1);`);
  await assert.rejects(
    opencodeComplete({}, bin)(judge, "S", "P", new AbortController().signal),
    /exited 1: free tier rate limited/,
  );
});

test("opencodeComplete kills the process on abort", async () => {
  const bin = fakeOpencode(`setTimeout(() => {}, 60000);`);
  const controller = new AbortController();
  const pending = opencodeComplete({}, bin)(judge, "S", "P", controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, /exited null/);
});
