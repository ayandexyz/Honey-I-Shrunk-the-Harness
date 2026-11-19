import assert from "node:assert/strict";
import test from "node:test";
import type { AIProvider } from "../providers/types.js";
import type { MemoryAuxiliaryCall } from "../memory/auxiliary.js";
import { createLlmSummarizer } from "./llm-summarizer.js";

const input = {
  sessionId: "session-1",
  messages: [
    {
      id: "m1",
      role: "user" as const,
      content: "summarize me",
      timestamp: 1,
      tokenCount: 3,
    },
  ],
};

test("LLM compaction reports its resolved model and usage once", async () => {
  const provider: AIProvider = {
    info: {
      id: "anthropic",
      name: "Anthropic",
      supportsStreaming: false,
      supportsTools: false,
      maxOutputTokens: 1024,
    },
    async execute() {
      return {
        content: "## Goal\n- keep the ledger honest",
        stopReason: "stop",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: { inputTokens: 123, outputTokens: 45 },
      };
    },
  };
  const calls: MemoryAuxiliaryCall[] = [];
  const summarize = createLlmSummarizer(
    provider,
    undefined,
    undefined,
    (call) => calls.push(call),
  );
  await summarize(input);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { ...calls[0], duration_ms: 0 },
    {
      purpose: "compaction",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      duration_ms: 0,
      outcome: "succeeded",
      usage: { inputTokens: 123, outputTokens: 45 },
    },
  );
});

test("failed LLM compaction remains a visible unknown-usage attempt", async () => {
  const provider: AIProvider = {
    info: {
      id: "anthropic",
      name: "Anthropic",
      supportsStreaming: false,
      supportsTools: false,
      maxOutputTokens: 1024,
    },
    async execute() {
      throw new Error("offline");
    },
  };
  const calls: MemoryAuxiliaryCall[] = [];
  const summarize = createLlmSummarizer(
    provider,
    "claude-sonnet-4-5",
    undefined,
    (call) => calls.push(call),
  );
  await assert.rejects(summarize(input), /offline/);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { ...calls[0], duration_ms: 0 },
    {
      purpose: "compaction",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      duration_ms: 0,
      outcome: "failed",
    },
  );
});

test("empty compaction output records the successful provider attempt once", async () => {
  const provider: AIProvider = {
    info: {
      id: "anthropic",
      name: "Anthropic",
      supportsStreaming: false,
      supportsTools: false,
      maxOutputTokens: 1024,
    },
    async execute() {
      return {
        content: "",
        stopReason: "stop",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: { inputTokens: 10, outputTokens: 0 },
      };
    },
  };
  const calls: MemoryAuxiliaryCall[] = [];
  const summarize = createLlmSummarizer(
    provider,
    undefined,
    undefined,
    (call) => calls.push(call),
  );
  await assert.rejects(summarize(input), /empty summary/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.outcome, "succeeded");
  assert.deepEqual(calls[0]?.usage, { inputTokens: 10, outputTokens: 0 });
});

test("a summary cut off at maxTokens is rejected, not kept", async () => {
  let maxTokens: number | undefined;
  const provider: AIProvider = {
    info: {
      id: "zai",
      name: "Z.ai",
      supportsStreaming: false,
      supportsTools: false,
      maxOutputTokens: 1024,
    },
    async execute(options) {
      maxTokens = options.maxTokens;
      return {
        content: "## Goal\n- wire the flag\n## Done\n- edited src/cli/ar",
        stopReason: "max_tokens",
        provider: "zai",
        model: "glm-5.3",
        usage: { inputTokens: 10, outputTokens: 8192 },
      };
    },
  };
  await assert.rejects(createLlmSummarizer(provider, undefined)(input), /truncated/);
  // Room for a reasoning model's thinking AND the summary.
  assert.ok((maxTokens ?? 0) >= 8_192);
});

test("the LLM summarizer is shown the founding request the selector kept aside", async () => {
  let prompt = "";
  const provider = {
    info: { id: "anthropic", name: "Anthropic", supportsStreaming: false, supportsTools: false, maxOutputTokens: 1024 },
    async execute(opts: { prompt?: string }) {
      prompt = opts.prompt ?? "";
      return { content: "## Goal\n- x", stopReason: "stop", provider: "anthropic", model: "m" };
    },
  } as unknown as AIProvider;
  await createLlmSummarizer(provider, undefined)({ ...input, goal: "can i have multiple sessions with multiple models??" });
  assert.match(prompt, /original request[\s\S]*multiple sessions with multiple models/);
});

function overflowingProvider(fitsAt: number, prompts: string[]): AIProvider {
  return {
    info: { id: "minimax", name: "MiniMax", supportsStreaming: false, supportsTools: false, maxOutputTokens: 1024 },
    async execute(options) {
      prompts.push(String(options.prompt));
      const lines = String(options.prompt).match(/^user: m\d+$/gm)?.length ?? 0;
      if (lines > fitsAt) {
        throw Object.assign(new Error("invalid params, context window exceeds limit (2013)"), { status: 400 });
      }
      return { content: "## Goal\n- ok", stopReason: "stop", provider: "minimax", model: "m" };
    },
  };
}
const ten = {
  sessionId: "s",
  messages: Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`, role: "user" as const, content: `m${i}`, timestamp: i, tokenCount: 1,
  })),
};

test("a summarizer request that is too long drops the oldest fifth and retries", async () => {
  const prompts: string[] = [];
  const summary = await createLlmSummarizer(overflowingProvider(7, prompts), undefined)(ten);
  assert.equal(summary, "## Goal\n- ok");
  assert.equal(prompts.length, 3, "10 → 8 → 7 messages");
  assert.ok(!prompts[2].includes("user: m2\n"), "the oldest messages went");
  assert.ok(prompts[2].includes("user: m9"), "the newest stayed");
  assert.ok(prompts[2].includes("[earlier transcript truncated for compaction retry]"));
});

test("gives up after three retries, and never retries an unrelated error", async () => {
  const prompts: string[] = [];
  await assert.rejects(createLlmSummarizer(overflowingProvider(0, prompts), undefined)(ten), /context window/);
  assert.equal(prompts.length, 4, "one try and three retries");

  let calls = 0;
  const failing: AIProvider = {
    info: { id: "minimax", name: "MiniMax", supportsStreaming: false, supportsTools: false, maxOutputTokens: 1024 },
    async execute() {
      calls++;
      throw new Error("rate limited");
    },
  };
  await assert.rejects(createLlmSummarizer(failing, undefined)(ten), /rate limited/);
  assert.equal(calls, 1);
});
