import test from "node:test";
import assert from "node:assert/strict";
import {
  adaptiveTruncate,
  boundDisplayOutput,
  MAX_DISPLAY_CHARS,
} from "./truncate.js";
import { MAX_MODEL_OUTPUT_CHARS, TAIL_CHARS } from "./config.js";

const MARKER = /\.\.\. \[truncated \d+ chars total/;

test("output within the cap is returned untouched", () => {
  const r = adaptiveTruncate("short output", "t1");
  assert.deepEqual([r.modelOutput, r.truncated], ["short output", false]);
});

test("both bookends land on line boundaries", () => {
  const output = Array.from(
    { length: 600 },
    (_, i) => `${i}: ${"a".repeat(90)}`,
  ).join("\n");
  assert.ok(
    output.length > MAX_MODEL_OUTPUT_CHARS,
    "fixture must exceed the cap",
  );

  const { modelOutput, truncated } = adaptiveTruncate(output, "t2");
  assert.equal(truncated, true);
  assert.match(modelOutput, MARKER);

  const END = "] ...\n\n";
  const headPart = modelOutput.slice(
    0,
    modelOutput.indexOf("\n\n... [truncated"),
  );
  const tailPart = modelOutput.slice(modelOutput.lastIndexOf(END) + END.length);

  // The head is a prefix of the original ending exactly where a line ends.
  assert.ok(output.startsWith(headPart));
  assert.equal(output[headPart.length], "\n");

  // The tail is a suffix of the original starting exactly after a line ends.
  assert.ok(output.endsWith(tailPart));
  assert.equal(output[output.length - tailPart.length - 1], "\n");

  // Snapping trims, never grows, the tail budget.
  assert.ok(tailPart.length <= TAIL_CHARS);
});

test("a single line longer than the budget still truncates", () => {
  const output = "q".repeat(MAX_MODEL_OUTPUT_CHARS * 2); // no newlines at all
  const { modelOutput, truncated } = adaptiveTruncate(output, "t3");

  assert.equal(truncated, true);
  assert.match(modelOutput, MARKER);
  assert.ok(modelOutput.length < output.length);
});

test("the marker carries the retrieval handle", () => {
  const output = Array.from({ length: 600 }, () => "b".repeat(90)).join("\n");
  const { modelOutput } = adaptiveTruncate(output, "call-42");

  assert.match(modelOutput, /id="call-42"/);
  assert.match(modelOutput, /`output` tool/);
});

test("frontend completion output is bounded while preserving the full length", () => {
  const output = "head\n" + "x".repeat(MAX_DISPLAY_CHARS + 100) + "\ntail";
  const result = boundDisplayOutput(output);

  assert.equal(result.truncated, true);
  assert.equal(result.totalChars, output.length);
  assert.ok(result.displayOutput.length <= MAX_DISPLAY_CHARS + 120);
  assert.ok(result.displayOutput.endsWith("tail"));
  assert.match(
    result.displayOutput,
    /full output available via the output tool/,
  );
});

test("short frontend completion output remains unchanged", () => {
  assert.deepEqual(boundDisplayOutput("ok"), {
    displayOutput: "ok",
    truncated: false,
    totalChars: 2,
  });
});
