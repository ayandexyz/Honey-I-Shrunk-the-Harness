import test from "node:test";
import assert from "node:assert/strict";
import {
  renderToolActivity,
  renderTurnForMemory,
} from "./tool-transcript.js";

test("renders one line per tool call with args and outcome", () => {
  const out = renderToolActivity(
    [
      { tool: "read", args: { filePath: "src/a.ts" }, output: "export const a = 1;" },
      { tool: "bash", args: { command: "pnpm test" }, error: "exit 1" },
    ],
    4_000,
  );

  assert.match(out, /Tool read: \{"filePath":"src\/a\.ts"\} -> export const a = 1;/);
  assert.match(out, /Tool bash: .* -> failed: exit 1/);
});

// The summarizer mines these two things out of the transcript; if the format
// drifts, extractToolCalls and extractFiles quietly match nothing again.
test("stays in the format summarizer.ts greps for", () => {
  const out = renderToolActivity(
    [{ tool: "edit", args: { filePath: "apps/core/src/x.ts" }, output: "ok" }],
    4_000,
  );
  assert.ok(/Tool (\w+):/.exec(out), "extractToolCalls must match");
  assert.ok(/(?:apps|packages|docs)\/[^\s)`'"]+/.exec(out), "extractFiles must match");
});

test("drops the oldest lines, not the newest, when over budget", () => {
  const activity = Array.from({ length: 40 }, (_, i) => ({
    tool: "read",
    args: { filePath: `src/f${i}.ts` },
    output: "x".repeat(300),
  }));

  const out = renderToolActivity(activity, 1_000);

  assert.ok(out.length <= 1_200, `budget respected, got ${out.length}`);
  assert.match(out, /^\[\d+ earlier tool calls omitted\]/);
  assert.match(out, /f39\.ts/, "the most recent call must survive");
  assert.doesNotMatch(out, /f0\.ts/);
});

test("a successful call with no output still reports that it ran", () => {
  assert.match(renderToolActivity([{ tool: "write" }], 4_000), /Tool write: -> ok/);
});

test("renderTurnForMemory keeps the assistant text above the transcript", () => {
  const out = renderTurnForMemory(
    "Fixing the failing test.",
    [{ tool: "edit", args: { filePath: "a.ts" }, output: "ok" }],
    4_000,
  );
  assert.equal(out.split("\n")[0], "Fixing the failing test.");
  assert.match(out, /Tool edit:/);
});

test("renderTurnForMemory with no text is the transcript alone", () => {
  const out = renderTurnForMemory("", [{ tool: "ls", output: "a b" }], 4_000);
  assert.equal(out, "Tool ls: -> a b");
});

// Sessions 50f4745d / 8b4b7a32: at 200 chars per result, read's envelope was
// most of what reached the summarizer, so a summary named the files read but
// held nothing that was in them, and the model re-read them after compacting.
test("a read result reaches the summarizer as content, not its envelope", () => {
  const body = "export function resolveProviderModel(session) {\n  return session.model;\n}";
  const out = renderToolActivity(
    [
      {
        tool: "read",
        args: { filePath: "/p/apps/core/src/server.ts" },
        output: `<path>/p/apps/core/src/server.ts</path>\n<type>file</type>\n<content>\n${body}\n\n(End of file - total 3 lines)\n</content>`,
      },
    ],
    10_000,
  );
  assert.doesNotMatch(out, /<path>|<type>|<\/?content>/);
  assert.match(out, /-> export function resolveProviderModel\(session\) \{ return session\.model; \}/);
});

test("a result up to 2,000 chars is kept whole", () => {
  const output = `${"a".repeat(1_990)} TAIL`;
  const out = renderToolActivity([{ tool: "grep", args: { pattern: "x" }, output }], 10_000);
  assert.match(out, / TAIL$/);
  const long = renderToolActivity(
    [{ tool: "grep", args: { pattern: "x" }, output: "b".repeat(5_000) }],
    10_000,
  );
  assert.ok(long.length < 2_100, `clipped, got ${long.length}`);
});
