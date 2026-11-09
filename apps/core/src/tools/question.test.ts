import test from "node:test";
import assert from "node:assert/strict";
import { QuestionTool } from "./question.js";
import type { ToolContext } from "./types.js";

const ctx: ToolContext = { cwd: "/tmp" };

const questions = [
  {
    question: "Which approach do you want?",
    options: [{ label: "Option A" }, { label: "Option B" }],
  },
];

test("a hook's pre-filled answers are honored without asking the bus", async () => {
  const res = await QuestionTool.execute(
    { questions, answers: { "Which approach do you want?": "Option A" } },
    ctx,
  );
  assert.equal(res.success, true);
  assert.ok(res.success && res.result.output.includes('"Which approach do you want?"="Option A"'));
  assert.equal(res.success && res.result.metadata?.answeredExternally, true);
});

test("a partial answers map falls through to the normal ask instead of guessing", async () => {
  // No bus listener is attached in this test process, so the normal ask path
  // rejects immediately with its own distinct error — proving the pre-filled
  // short-circuit above did NOT fire for an incomplete map.
  const res = await QuestionTool.execute(
    {
      questions: [
        ...questions,
        { question: "A second question?", options: [{ label: "Yes" }] },
      ],
      // Only answers the first question — the second is missing.
      answers: { "Which approach do you want?": "Option A" },
    },
    ctx,
  );
  assert.equal(res.success, false);
  assert.ok(!res.success && res.error.includes("No frontend connected"), res.success ? "" : res.error);
});

test("no answers field at all still falls through to the normal ask", async () => {
  const res = await QuestionTool.execute({ questions }, ctx);
  assert.equal(res.success, false);
  assert.ok(!res.success && res.error.includes("No frontend connected"), res.success ? "" : res.error);
});

test("asking a person raises a question notification first", async () => {
  const { registerHook, unregisterAllHooks } = await import("../hooks/registry.js");
  unregisterAllHooks("settings");
  const seen: Array<Record<string, unknown>> = [];
  registerHook("Notification", "spy", {
    type: "callback",
    callback: async (input) => {
      seen.push(input.toolInput);
      return { action: "continue" };
    },
  });
  try {
    await QuestionTool.execute(
      {
        questions: [
          ...questions,
          { question: "A second question?", options: [{ label: "Yes" }] },
        ],
      },
      { ...ctx, sessionId: "s1" },
    );
    assert.deepEqual(seen, [
      { message: "Which approach do you want? (+1 more)", notificationType: "question" },
    ]);
  } finally {
    unregisterAllHooks("settings");
  }
});

test("pre-filled answers raise no notification", async () => {
  const { registerHook, unregisterAllHooks } = await import("../hooks/registry.js");
  unregisterAllHooks("settings");
  let fired = false;
  registerHook("Notification", "spy", {
    type: "callback",
    callback: async () => {
      fired = true;
      return { action: "continue" };
    },
  });
  try {
    await QuestionTool.execute(
      { questions, answers: { "Which approach do you want?": "Option A" } },
      ctx,
    );
    assert.equal(fired, false);
  } finally {
    unregisterAllHooks("settings");
  }
});
