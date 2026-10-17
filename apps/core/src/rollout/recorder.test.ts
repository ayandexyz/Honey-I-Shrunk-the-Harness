import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RolloutRecorder } from "./recorder.js";
import type {
  CompactOccurredEvent,
  FunctionDeniedEvent,
  FunctionOutputEvent,
  RolloutEvent,
} from "./types.js";

function readEvents(dir: string): RolloutEvent[] {
  return readFileSync(join(dir, "events.jsonl"), "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as RolloutEvent);
}

test("seq resumes across recorder instances for the same session", () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-rollout-"));
  try {
    const first = new RolloutRecorder("s1", { rolloutDir: dir });
    first.recordTurnStarted("turn-1");
    first.recordTurnStarted("turn-2");

    const second = new RolloutRecorder("s1", { rolloutDir: dir });
    second.recordTurnStarted("turn-3");

    assert.deepEqual(
      readEvents(dir).map((e) => e.seq),
      [1, 2, 3],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("function.output carries turnId and preserves falsy values", () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-rollout-"));
  try {
    const recorder = new RolloutRecorder("s1", { rolloutDir: dir });
    recorder.recordFunctionOutput("read", "", 0, "turn-1");

    const [event] = readEvents(dir) as FunctionOutputEvent[];
    assert.equal(event.type, "function.output");
    assert.equal(event.turnId, "turn-1");
    assert.equal(event.output, "");
    assert.equal(event.duration_ms, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model events round-trip every field through the JSONL log", () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-rollout-"));
  try {
    const recorder = new RolloutRecorder("s1", { rolloutDir: dir });
    recorder.recordModelRequest("turn-2", {
      provider: "minimax",
      model: "MiniMax-M3",
      messageCount: 12,
      toolCount: 15,
      promptChars: 48_000,
      streamed: true,
    });
    recorder.recordModelFirstToken("turn-2", 1500);
    recorder.recordModelResponse("turn-2", {
      provider: "minimax",
      model: "MiniMax-M3",
      duration_ms: 4200,
      ttft_ms: 1500,
      inputTokens: 12_000,
      // 0 must survive: "the model emitted nothing" is a real, diagnostic value.
      outputTokens: 0,
      cacheReadTokens: 11_000,
      cacheWriteTokens: 0,
      toolCalls: ["bash", "read"],
      textChars: 0,
      thinkingChars: 320,
    });

    const [request, firstToken, response] = readEvents(dir) as Array<
      Record<string, unknown>
    >;
    assert.equal(request.type, "model.request");
    assert.equal(request.turnId, "turn-2");
    assert.equal(request.promptChars, 48_000);
    assert.equal(request.streamed, true);
    assert.equal(firstToken.type, "model.first_token");
    assert.equal(firstToken.ttft_ms, 1500);
    assert.equal(response.type, "model.response");
    assert.equal(response.duration_ms, 4200);
    assert.equal(response.outputTokens, 0);
    assert.deepEqual(response.toolCalls, ["bash", "read"]);
    // Sequence numbers keep the three lines orderable after the fact.
    assert.deepEqual([request.seq, firstToken.seq, response.seq], [1, 2, 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compaction records distinct token scales and the body-free boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-rollout-"));
  try {
    const recorder = new RolloutRecorder("s1", { rolloutDir: dir });
    recorder.recordCompactOccurred({
      estimatedTranscriptTokensBefore: 12_000,
      estimatedTranscriptTokensAfter: 3_000,
      providerRequestTokensBefore: 98_000,
      messagesBefore: 14,
      messagesAfter: 4,
      compactedMessageIds: ["m1", "m2"],
      preservedMessageIds: ["m3", "m4"],
    });

    const [event] = readEvents(dir) as CompactOccurredEvent[];
    assert.equal(event.type, "compact.occurred");
    assert.equal(event.estimatedTranscriptTokensBefore, 12_000);
    assert.equal(event.estimatedTranscriptTokensAfter, 3_000);
    assert.equal(event.providerRequestTokensBefore, 98_000);
    assert.equal(event.messagesBefore, 14);
    assert.equal(event.messagesAfter, 4);
    assert.deepEqual(event.compactedMessageIds, ["m1", "m2"]);
    assert.deepEqual(event.preservedMessageIds, ["m3", "m4"]);
    assert.equal(event.beforeTokens, undefined);
    assert.equal(event.afterTokens, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model.error records the stall kind", () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-rollout-"));
  try {
    const recorder = new RolloutRecorder("s1", { rolloutDir: dir });
    recorder.recordModelError("turn-0", {
      provider: "minimax",
      model: "MiniMax-M3",
      duration_ms: 120_000,
      kind: "stall",
      error: "Provider sent no response for 120s",
    });
    const [event] = readEvents(dir) as Array<Record<string, unknown>>;
    assert.equal(event.type, "model.error");
    assert.equal(event.kind, "stall");
    assert.equal(event.duration_ms, 120_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory auxiliary calls retain usage separately from model responses", () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-rollout-"));
  try {
    const recorder = new RolloutRecorder("s1", { rolloutDir: dir });
    recorder.recordMemoryAuxiliary("turn-4", {
      purpose: "retrieval_judge",
      provider: "anthropic",
      model: "claude-haiku",
      duration_ms: 321,
      outcome: "succeeded",
      inputTokens: 123,
      outputTokens: 4,
      cacheReadTokens: 100,
      authMode: "oauth",
    });

    const [event] = readEvents(dir) as Array<Record<string, unknown>>;
    assert.equal(event.type, "memory.auxiliary");
    assert.equal(event.turnId, "turn-4");
    assert.equal(event.purpose, "retrieval_judge");
    assert.equal(event.inputTokens, 123);
    assert.equal(event.cacheReadTokens, 100);
    assert.equal(event.authMode, "oauth");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("memory exposure records every provider-request measurement", () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-rollout-"));
  try {
    const recorder = new RolloutRecorder("s1", { rolloutDir: dir });
    recorder.recordMemoryExposure("turn-4", {
      blockBytes: 2048,
      estimatedTokens: 512,
      candidateCount: 8,
      renderedCount: 3,
      injected: true,
      preparation: "fresh",
      judgeDecision: "judge_ran",
    });

    const [event] = readEvents(dir) as Array<Record<string, unknown>>;
    assert.equal(event.type, "memory.exposure");
    assert.equal(event.turnId, "turn-4");
    assert.equal(event.blockBytes, 2048);
    assert.equal(event.estimatedTokens, 512);
    assert.equal(event.candidateCount, 8);
    assert.equal(event.renderedCount, 3);
    assert.equal(event.injected, true);
    assert.equal(event.preparation, "fresh");
    assert.equal(event.judgeDecision, "judge_ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("function.denied records the tool, the gate, and the reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-rollout-"));
  try {
    const recorder = new RolloutRecorder("s1", { rolloutDir: dir });
    recorder.recordFunctionDenied(
      "edit",
      { filePath: "match.ts" },
      "mode",
      'Tool "edit" is not allowed in review mode (read-only)',
      "turn-3",
    );

    const [event] = readEvents(dir) as FunctionDeniedEvent[];
    assert.equal(event.type, "function.denied");
    assert.equal(event.tool, "edit");
    assert.equal(event.source, "mode");
    assert.equal(event.turnId, "turn-3");
    assert.deepEqual(event.args, { filePath: "match.ts" });
    assert.match(event.reason, /review mode/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify.ran and unwired.flagged carry counts only", () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-rollout-"));
  try {
    const recorder = new RolloutRecorder("s1", { rolloutDir: dir });
    recorder.recordVerifyRan("tests", false, 1234, 2);
    recorder.recordUnwiredFlagged(3);
    const [ran, flagged] = readEvents(dir) as unknown as Record<
      string,
      unknown
    >[];
    assert.equal(ran.type, "verify.ran");
    assert.deepEqual(
      [ran.kind, ran.ok, ran.ms, ran.failing],
      ["tests", false, 1234, 2],
    );
    assert.equal(flagged.type, "unwired.flagged");
    assert.equal(flagged.count, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
