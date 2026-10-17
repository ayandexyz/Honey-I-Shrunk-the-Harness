// =============================================================================
// Post-compaction restore end to end (spec 2026-10-13-stuck-loop-recovery.md
// §4.3): the real loop reads a file, compacts, and the next request carries the
// file inside the summary block — and a re-read then gets the "unchanged" stub,
// which is now true. With FREECODE_COMPACT_RESTORE=0 nothing is attached and,
// since compaction ended dedup, the re-read returns the file itself.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import type {
  AIProvider,
  ExecuteOptions,
  ProviderChunk,
  SystemBlock,
} from "../providers/types.js";

const MARKER = "export const restoredMarker = 42;";
const info = {
  id: "restore-fake",
  name: "restore-fake",
  defaultModel: "fake-model",
  supportsStreaming: true,
  supportsTools: true,
};

let target = "";
let other = "";
/** What the next run reads: the target first, then another file, then the target again. */
let reading = "";
/** Every request's system text, in order. */
const systems: string[] = [];
let calls = 0;

registerProvider("restore-fake" as ProviderId, {
  info,
  create: (): AIProvider => ({
    info,
    execute: async () => ({
      content: "summary of the earlier work",
      stopReason: "stop",
      provider: "restore-fake",
      model: "fake-model",
    }),
    // Each run: read one file, then stop.
    stream: async function* (
      opts: ExecuteOptions,
    ): AsyncGenerator<ProviderChunk> {
      const sys = opts.system;
      systems.push(
        typeof sys === "string"
          ? sys
          : ((sys as SystemBlock[] | undefined) ?? [])
              .map((b) => b.text)
              .join("\n"),
      );
      calls++;
      if (calls % 2 === 1) {
        yield {
          type: "tool_call",
          id: `c${calls}`,
          name: "read",
          args: { filePath: reading },
        };
      } else {
        yield { type: "text_delta", delta: "done" };
      }
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    },
  }),
});

async function scenario(restore: boolean) {
  systems.length = 0;
  calls = 0;
  const sessionId = `restore-${restore}`;
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-restore-rollout-"));
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-restore-project-"));
  target = join(projectPath, "target.ts");
  writeFileSync(target, `${MARKER}\n`);
  other = join(projectPath, "other.ts");
  writeFileSync(other, "export const other = 0;\n");
  const prev = process.env.FREECODE_COMPACT_RESTORE;
  process.env.FREECODE_COMPACT_RESTORE = restore ? "1" : "0";
  const runtime = makeRuntime(
    makeTestLayer({
      memoryFactory: {
        forSession: () =>
          new MemoryService(sessionId, {
            storage: {
              save: () => {},
              load: () => undefined,
              listSessions: () => [],
              delete: () => {},
            } as never,
          }),
      },
      recorderFactory: {
        forSession: (id: string) => createRecorder(id, { rolloutDir }),
      },
    }),
  );
  try {
    const store = await runtime.runPromise(SessionStoreTag);
    await store.createSession(
      { title: "t", projectPath, provider: "restore-fake" },
      sessionId,
    );
    const loop = await runtime.runPromise(
      createAgentLoopEffect(sessionId, { maxIterations: 4 }),
    );
    const run = (prompt: string) =>
      loop.run({
        prompt,
        sessionId,
        provider: "restore-fake",
        projectPath,
        agentMode: "danger",
      });
    // The target is read only in the first of three turns, so after compaction
    // (which keeps the last two) its read survives nowhere but the restore.
    reading = target;
    await run("one");
    reading = other;
    await run("two");
    await run("three");
    const outcome = await loop.runCompaction(
      "restore-fake",
      undefined,
      "manual",
    );
    assert.equal(outcome.compacted, true, "the scenario must actually compact");
    const before = systems.length;
    reading = target;
    await run("four");
    const afterCompaction = systems[before]!;
    const file = join(rolloutDir, "events.jsonl");
    const events = existsSync(file)
      ? readFileSync(file, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const lastRead = events
      .filter((e) => e.type === "function.output" && e.tool === "read")
      .at(-1);
    return { afterCompaction, lastRead, events };
  } finally {
    if (prev === undefined) delete process.env.FREECODE_COMPACT_RESTORE;
    else process.env.FREECODE_COMPACT_RESTORE = prev;
    await runtime.dispose();
    rmSync(rolloutDir, { recursive: true, force: true });
    rmSync(projectPath, { recursive: true, force: true });
  }
}

test("after compaction the recent file rides the summary, and a re-read is honestly 'unchanged'", async () => {
  const { afterCompaction, lastRead, events } = await scenario(true);
  assert.match(afterCompaction, /Compacted session summary:/);
  assert.match(afterCompaction, /re-attached after compaction/);
  assert.ok(
    afterCompaction.includes(MARKER),
    "the file's content is in the request",
  );
  assert.ok(
    !afterCompaction.includes("export const other"),
    "a file still in the kept turns is not repeated",
  );
  assert.match(
    lastRead.output,
    /<unchanged>/,
    "the stub now points at content that is there",
  );
  const restored = events.filter((e) => e.type === "compact.restored");
  assert.equal(restored.length, 1);
  assert.equal(restored[0].files, 1);
  assert.ok(
    !JSON.stringify(restored).includes("target.ts"),
    "paths never enter the log",
  );
  const compacted = events.filter((e) => e.type === "compact.occurred");
  assert.equal(compacted.length, 1);
  assert.equal(compacted[0].providerRequestTokensBefore, 10);
  assert.ok(compacted[0].estimatedTranscriptTokensBefore > 0);
  assert.ok(compacted[0].messagesBefore > compacted[0].messagesAfter);
  assert.equal(
    compacted[0].compactedMessageIds.length +
      compacted[0].preservedMessageIds.length,
    compacted[0].messagesBefore,
  );
  assert.ok(
    !JSON.stringify(compacted).includes(MARKER),
    "message bodies never enter the log",
  );
});

test("with restore off nothing is attached, and the re-read returns the file, not a stub", async () => {
  const { afterCompaction, lastRead, events } = await scenario(false);
  assert.match(afterCompaction, /Compacted session summary:/);
  assert.doesNotMatch(afterCompaction, /re-attached after compaction/);
  assert.ok(
    lastRead.output.includes(MARKER),
    "compaction ended dedup: the real content comes back",
  );
  assert.equal(events.filter((e) => e.type === "compact.restored").length, 0);
});
