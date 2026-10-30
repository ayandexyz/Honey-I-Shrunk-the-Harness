import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHookRuntime } from "../hooks/runtime.js";
import { FileMemoryStorage } from "./storage.js";
import { MemoryService } from "./service.js";

// The compaction thresholds asserted below are the *defaults*; an ambient
// override in the developer's shell must not decide whether they pass.
delete process.env.FREECODE_COMPACT_TARGET_TOKENS;
delete process.env.FREECODE_AUTO_COMPACT_TOKENS;

test("MemoryService compacts old messages and exposes prompt context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-memory-"));
  try {
    const service = new MemoryService("session-1", {
      storage: new FileMemoryStorage(dir),
      hooks: createHookRuntime(),
    });

    service.addMessage("user", "old request in docs/plans/x.md");
    service.addMessage("assistant", "old answer");
    service.addMessage("user", "second request");
    service.addMessage("assistant", "second answer");
    service.addMessage("user", "middle request");
    service.addMessage("assistant", "middle answer");
    service.addMessage("user", "latest request");
    service.addMessage("assistant", "latest answer");

    const result = await service.compact();
    const context = service.getPromptContext();

    assert.equal(result.success, true);
    // The founding instruction is preserved verbatim at the head, not folded
    // into the summary — otherwise the next compaction summarizes the summary
    // of it, and the brief decays fastest of anything in the window.
    assert.ok(context.summary?.includes("second request"));
    assert.deepEqual(
      context.recentMessages.map((message) => message.content),
      [
        "old request in docs/plans/x.md",
        "middle request",
        "middle answer",
        "latest request",
        "latest answer",
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemoryService respects PreCompact block", async () => {
  const hooks = {
    ...createHookRuntime(),
    async runPreCompact() {
      return { allowed: false, blockReason: "blocked by test" };
    },
  };

  const service = new MemoryService("session-1", { hooks });
  service.addMessage("user", "old request");
  service.addMessage("assistant", "old answer");
  service.addMessage("user", "middle request");
  service.addMessage("assistant", "middle answer");
  service.addMessage("user", "latest request");
  service.addMessage("assistant", "latest answer");

  const result = await service.compact();

  assert.equal(result.success, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "blocked by test");
});

test("blocked compaction backs off instead of retrying every message", async () => {
  const hooks = {
    ...createHookRuntime(),
    async runPreCompact() {
      return { allowed: false, blockReason: "blocked by test" };
    },
  };

  const dir = mkdtempSync(join(tmpdir(), "freecode-memory-"));
  try {
    const service = new MemoryService(`session-backoff-${Date.now()}`, {
      hooks,
      storage: new FileMemoryStorage(dir),
      // Buffer larger than the context limit → threshold 0 → always due
      config: { autoCompactBufferTokens: 1_000_000 },
    });
    service.addMessage("user", "old request");
    service.addMessage("assistant", "old answer");
    service.addMessage("user", "middle request");
    service.addMessage("assistant", "middle answer");
    service.addMessage("user", "latest request");

    assert.equal(service.shouldCompact("gpt-4o"), true);
    const result = await service.compact();
    assert.equal(result.blocked, true);
    assert.equal(service.shouldCompact("gpt-4o"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldCompact uses the provider's measured tokens over its own estimate", () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-memory-"));
  try {
    const service = new MemoryService(`session-measured-${Date.now()}`, {
      storage: new FileMemoryStorage(dir),
      config: { autoCompactBufferTokens: 10_000 },
    });

    // A tool-heavy turn: the real request was huge, but memory only recorded
    // the stub, so its own estimate stays tiny.
    service.addMessage("user", "read every file");
    service.addMessage("assistant", "[Executed 1 tools]");

    // Estimate alone is nowhere near the limit — this is the old behaviour
    // that let sessions overflow the window without ever compacting.
    assert.equal(service.shouldCompact("MiniMax-M2", 196_608), false);

    // Given what the provider actually measured, it must fire.
    assert.equal(service.shouldCompact("MiniMax-M2", 196_608, 190_000), true);
    // Still below the threshold once the buffer is applied.
    assert.equal(service.shouldCompact("MiniMax-M2", 196_608, 100_000), false);
    // A zero/absent measurement falls back to the estimate rather than
    // reading as "empty context".
    assert.equal(service.shouldCompact("MiniMax-M2", 196_608, 0), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a compaction that does not shrink the measured context holds instead of re-firing every turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-memory-"));
  try {
    const service = new MemoryService(`session-thrash-${Date.now()}`, {
      storage: new FileMemoryStorage(dir),
      config: { autoCompactBufferTokens: 10_000 },
    });
    service.addMessage("user", "make it faster");
    for (let i = 0; i < 6; i++) service.addMessage("assistant", `tool turn ${i}`);

    // Measured 130K: system prompt + schemas dominate; the transcript is tiny.
    assert.equal(service.shouldCompact("MiniMax-M2", 196_608, 130_000), true);
    const result = await service.compact();
    assert.ok(result.compactedMessageIds.length > 0);

    // Next request is no smaller — compaction could not touch what counts.
    assert.equal(service.shouldCompact("MiniMax-M2", 196_608, 131_000), false);
    // Grown past the back-off window: due again.
    assert.equal(service.shouldCompact("MiniMax-M2", 196_608, 136_000), true);
    // Or it actually shrank below the compaction point: normal rule applies.
    await service.compact();
    assert.equal(service.shouldCompact("MiniMax-M2", 196_608, 60_000), false);
    assert.equal(service.shouldCompact("MiniMax-M2", 196_608, 120_000), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a turn-count cooldown blocks a re-fire even when tokens have grown enough (jcode-style second line of defense)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-memory-"));
  try {
    const service = new MemoryService(`session-cooldown-${Date.now()}`, {
      storage: new FileMemoryStorage(dir),
      config: { autoCompactBufferTokens: 10_000, minTurnsBetweenCompactions: 5 },
    });
    service.addMessage("user", "make it faster");
    for (let i = 0; i < 6; i++) service.addMessage("assistant", `tool turn ${i}`);

    assert.equal(service.shouldCompact("MiniMax-M2", 196_608, 130_000), true);
    const result = await service.compact();
    assert.ok(result.compactedMessageIds.length > 0);

    // Token growth alone would clear the BLOCKED_RETRY_GROWTH_TOKENS guard
    // (well past +5,000), but the cooldown has not elapsed yet.
    for (let i = 0; i < 4; i++) {
      assert.equal(
        service.shouldCompact("MiniMax-M2", 196_608, 500_000),
        false,
        `call ${i + 1} after the compaction must still be held by the cooldown`,
      );
    }
    // The 5th call clears minTurnsBetweenCompactions=5.
    assert.equal(service.shouldCompact("MiniMax-M2", 196_608, 500_000), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the cooldown never blocks a session's first compaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-memory-"));
  try {
    const service = new MemoryService(`session-first-${Date.now()}`, {
      storage: new FileMemoryStorage(dir),
      config: { autoCompactBufferTokens: 10_000, minTurnsBetweenCompactions: 10 },
    });
    service.addMessage("user", "make it faster");
    for (let i = 0; i < 6; i++) service.addMessage("assistant", `tool turn ${i}`);

    // A brand-new session must never be held back by a cooldown it hasn't
    // earned yet — only a repeat within minTurnsBetweenCompactions of a
    // PRIOR real compaction is blocked.
    assert.equal(service.shouldCompact("MiniMax-M2", 196_608, 130_000), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
