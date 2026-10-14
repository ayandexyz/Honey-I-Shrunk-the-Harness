// =============================================================================
// Finish-time verification end to end (spec 2026-10-13-finish-time-
// verification.md §2.1–2.2): the real loop, a scripted fake model.
// =============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bus } from "../bus/index.js";
import { disposeRoot } from "../tools/lsp/client.js";
import { makeTestLayer } from "../effect/layers.js";
import { makeRuntime } from "../effect/runtime.js";
import { SessionStoreTag } from "../effect/context.js";
import { createAgentLoopEffect } from "./loop.js";
import { MemoryService } from "../compaction/service.js";
import { createRecorder } from "../rollout/recorder.js";
import { registerProvider } from "../providers/registry.js";
import type { ProviderId } from "../providers/config.js";
import type { AIProvider, ExecuteOptions, ProviderChunk } from "../providers/types.js";

type Step = { write?: [string, string]; say?: string };
let script: Step[] = [];
const tails: string[] = [];
const info = { id: "finish-fake", name: "finish-fake", defaultModel: "m", supportsStreaming: true, supportsTools: true };

registerProvider("finish-fake" as ProviderId, {
  info,
  create: (): AIProvider => ({
    info,
    execute: async () => { throw new Error("not used"); },
    stream: async function* (opts: ExecuteOptions): AsyncGenerator<ProviderChunk> {
      // The verifier subagent: always passes, so it never consumes the script.
      if (JSON.stringify(opts).includes("adversarially verify")) {
        yield { type: "text_delta", delta: "Looks fine.\nVERDICT: PASS" };
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      tails.push(opts.ephemeralTail ?? "");
      const step = script.shift() ?? { say: "done" };
      if (step.write) {
        yield { type: "tool_call", id: `c${tails.length}`, name: "write", args: { filePath: step.write[0], content: step.write[1] } };
      } else {
        yield { type: "text_delta", delta: step.say ?? "done" };
      }
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } };
    },
  }),
});

async function run(projectPath: string, steps: Step[], config: { finishTests?: boolean } = {}) {
  script = steps;
  tails.length = 0;
  const sessionId = `finish-${Math.random().toString(36).slice(2)}`;
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-finish-rollout-"));
  const runtime = makeRuntime(
    makeTestLayer({
      memoryFactory: {
        forSession: () => new MemoryService(sessionId, { storage: { save: () => {}, load: () => undefined, listSessions: () => [], delete: () => {} } as never }),
      },
      recorderFactory: { forSession: (id: string) => createRecorder(id, { rolloutDir }) },
    }),
  );
  try {
    const store = await runtime.runPromise(SessionStoreTag);
    await store.createSession({ title: "t", projectPath, provider: "finish-fake" }, sessionId);
    const loop = await runtime.runPromise(createAgentLoopEffect(sessionId, { maxIterations: 20, ...config }));
    await loop.run({ prompt: "change it", sessionId, provider: "finish-fake", projectPath, agentMode: "danger" });
    const f = join(rolloutDir, "events.jsonl");
    return existsSync(f) ? readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  } finally {
    await runtime.dispose();
    rmSync(rolloutDir, { recursive: true, force: true });
    // Edit-time diagnostics is on by default: `main.ts`/`lib.ts` below spawn a
    // real typescript-language-server rooted at `projectPath`, which outlives
    // this run and hangs the test file's own exit unless disposed here.
    disposeRoot(projectPath);
  }
}

test("the verify gate says what it runs and how it went, and logs the real script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-finish-notice-"));
  const notices: string[] = [];
  const unsub = bus.subscribe("stream", (e) => {
    const ev = (e as { event: { type: string; content?: string } }).event;
    if (ev.type === "notice") notices.push(ev.content ?? "");
  });
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { typecheck: "node -e 0" } }));
    const events = await run(dir, [{ write: [join(dir, "a.txt"), "a"] }, { say: "done" }]);
    assert.ok(notices.some((n) => /^Verifying: \S+ run typecheck$/.test(n)), notices.join(" | "));
    assert.ok(notices.some((n) => /^typecheck passed \(\d+s\)$/.test(n)), notices.join(" | "));
    const ran = events.filter((e) => e.type === "verify.ran" && e.kind === "typecheck");
    assert.deepEqual(ran.map((e) => e.script), ["typecheck"]);
  } finally {
    unsub();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ≥3-file change runs the package's tests; a failure comes back once, the fix finishes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-finish-tests-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node check.mjs" } }));
    writeFileSync(join(dir, "check.mjs"), `import { readFileSync } from "node:fs";\nif (readFileSync(new URL("./c.txt", import.meta.url), "utf-8") !== "fixed") { console.log("not ok 1 - c.txt is fixed"); process.exit(1); }\nconsole.log("ok 1");\n`);
    const events = await run(dir, [
      { write: [join(dir, "a.txt"), "a"] },
      { write: [join(dir, "b.txt"), "b"] },
      { write: [join(dir, "c.txt"), "broken"] },
      { say: "done" },
      { write: [join(dir, "c.txt"), "fixed"] },
      { say: "done" },
    ]);
    const told = tails.filter((t) => t.includes("the tests of the packages you touched were run"));
    assert.equal(told.length, 1, "one failure reminder");
    assert.match(told[0]!, /not ok 1 - c\.txt is fixed/);
    const ran = events.filter((e) => e.type === "verify.ran" && e.kind === "tests");
    assert.deepEqual(ran.map((e) => e.ok), [false, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a red suite that stays red ends after 2 attempts instead of looping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-finish-red-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"console.log('not ok 1 - always'); process.exit(1)\"" } }));
    const events = await run(dir, [
      { write: [join(dir, "a.txt"), "a"] },
      { write: [join(dir, "b.txt"), "b"] },
      { write: [join(dir, "c.txt"), "c"] },
      { say: "done" },
      { say: "That test was already failing before my change." },
      { say: "Already failing." },
    ]);
    assert.equal(events.filter((e) => e.type === "verify.ran" && e.kind === "tests").length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new function nobody calls gets one reminder naming it, and an answer ends it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-finish-unwired-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });
  try {
    git("init", "-q");
    writeFileSync(join(dir, "main.ts"), "console.log(1);\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    const events = await run(dir, [
      { write: [join(dir, "lib.ts"), "export function helper() {\n  return 1;\n}\n"] },
      { say: "done" },
      { say: "helper is intentionally unused for now." },
    ]);
    const told = tails.filter((t) => t.includes("Nothing outside test files calls these"));
    assert.equal(told.length, 1);
    assert.match(told[0]!, /helper \(lib\.ts:1\)/);
    assert.deepEqual(events.filter((e) => e.type === "unwired.flagged").map((e) => e.count), [1]);
    // The write call itself logs its arguments (existing behaviour); the new
    // event must not add the names (spec §2.4).
    assert.ok(!JSON.stringify(events.filter((e) => e.type === "unwired.flagged")).includes("helper"), "names never enter the new event");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a subagent-style loop (finishTests: false) leaves the suite to its parent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "freecode-finish-sub-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(1)\"" } }));
    const events = await run(
      dir,
      [
        { write: [join(dir, "a.txt"), "a"] },
        { write: [join(dir, "b.txt"), "b"] },
        { write: [join(dir, "c.txt"), "c"] },
        { say: "done" },
      ],
      { finishTests: false },
    );
    assert.equal(events.filter((e) => e.type === "verify.ran" && e.kind === "tests").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

