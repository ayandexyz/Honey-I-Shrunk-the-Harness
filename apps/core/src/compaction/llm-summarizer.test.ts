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
