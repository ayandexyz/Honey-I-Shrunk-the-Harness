// =============================================================================
// Signal E end to end (spec 2026-10-13-stuck-loop-recovery.md §4.1–4.2): the
// real loop against a fake model that keeps editing and keeps getting the same
// located error back from bash — the long-task run's stuck shape, which A–D
// cannot see because every call and every edit differs.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestLayer } from "../effect/layers.js";
import { makeRuntime } from "../effect/runtime.js";
import { SessionStoreTag } from "../effect/context.js";
import { createAgentLoopEffect } from "./loop.js";
import { MemoryService } from "../compaction/service.js";
import { createRecorder } from "../rollout/recorder.js";
import { registerProvider } from "../providers/registry.js";
import type { ProviderId } from "../providers/config.js";
import type { AIProvider, ExecuteOptions, ProviderChunk } from "../providers/types.js";

const ERROR = "src/a.ts(3,1): error TS1110: Type expected.";
const info = {
  id: "stuck-error-fake",
  name: "stuck-error-fake",
  defaultModel: "fake-model",
  supportsStreaming: true,
  supportsTools: true,
};

/** Every request's ephemeral tail, where reminders ride. */
const tails: string[] = [];
// Absolute: bash and write do not resolve against the test's project dir.
const projectPath = mkdtempSync(join(tmpdir(), "freecode-stuck-project-"));
// The same check spelled three ways, as a stuck model re-runs it: one command
// family for E, never three byte-identical calls in a row for A.
const SPELLINGS = ["", " 2>&1", " 2>&1  "];

registerProvider("stuck-error-fake" as ProviderId, {
  info,
  create: (): AIProvider => ({
    info,
    execute: async () => {
      throw new Error("not used");
    },
    // Turn 1: a clean check (the baseline). Then forever: edit, same error.
    stream: async function* (opts: ExecuteOptions): AsyncGenerator<ProviderChunk> {
      tails.push(opts.ephemeralTail ?? "");
      const n = tails.length;
      const edit = n > 1 && n % 2 === 0;
      const command = `node ${join(projectPath, "check.mjs")}${SPELLINGS[(n >> 1) % 3]}`;
      yield edit
        ? { type: "tool_call", id: `c${n}`, name: "write", args: { filePath: join(projectPath, "broken"), content: `try ${n}` } }
        : { type: "tool_call", id: `c${n}`, name: "bash", args: { command } };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    },
  }),
});

test("the same error back after every edit is named to the model once, and the run goes on", async () => {
  const sessionId = "stuck-error";
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-stuck-rollout-"));
  // Clean until a file exists, then the same tsc-shaped error every time.
  writeFileSync(
    join(projectPath, "check.mjs"),
    `import { existsSync } from "node:fs";\nif (existsSync(${JSON.stringify(join(projectPath, "broken"))})) { console.log(${JSON.stringify(ERROR)}); process.exit(2); }\nconsole.log("ok");\n`,
  );
  const runtime = makeRuntime(
    makeTestLayer({
      memoryFactory: {
        forSession: () =>
          new MemoryService(sessionId, {
            storage: { save: () => {}, load: () => undefined, listSessions: () => [], delete: () => {} } as never,
          }),
      },
      recorderFactory: { forSession: (id: string) => createRecorder(id, { rolloutDir }) },
    }),
  );
  try {
    const store = await runtime.runPromise(SessionStoreTag);
    await store.createSession({ title: "t", projectPath, provider: "stuck-error-fake" }, sessionId);
    // 1 clean check + 6 edit/check pairs: past the threshold (5), short of 2×.
    const loop = await runtime.runPromise(createAgentLoopEffect(sessionId, { maxIterations: 14 }));
    const result = await loop.run({
      prompt: "Fix the type error",
      sessionId,
      provider: "stuck-error-fake",
      projectPath,
      agentMode: "danger",
    });

    const nudged = tails.filter((t) => t.includes("The same error has come back"));
    assert.equal(nudged.length, 1, "once per run, not every turn");
    assert.match(nudged[0]!, /come back 5 times/);
    assert.ok(nudged[0]!.includes(ERROR), "quotes the error");
    assert.match(nudged[0]!, /\(src\/a\.ts:3\)/, "points at the line it names");

    // Warn-only: the loop ran to its cap, it was not stopped as stuck.
    assert.doesNotMatch(result.message ?? "", /repeated_error/);

    const file = join(rolloutDir, "events.jsonl");
    const events = existsSync(file)
      ? readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const warned = events.filter((e) => e.type === "loop.warned" && e.reason === "repeated_error");
    assert.equal(warned.length, 1);
    assert.equal(warned[0].count, 5);
    assert.equal(warned[0].reminded, true);
    assert.ok(!JSON.stringify(warned).includes("TS1110"), "the error text never enters the log");
  } finally {
    await runtime.dispose();
    rmSync(rolloutDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  }
});
