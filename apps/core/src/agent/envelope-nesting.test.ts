// =============================================================================
// The envelope's other two call sites: the tool list the model is offered, and
// the spawn boundary. A child inherits its parent's ceiling and can only narrow
// it — never widen it (spec §5.4).
//
// HOME is a temp dir before the tool modules load: the `agent` tool opens a
// session store under ~/.freecode.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freecode-envelope-nest-home-"));
process.env.HOME = home;

const { registerProvider } = await import("../providers/registry.js");
const { tools } = await import("../tools/index.js");
const { getAgentRegistry } = await import("../agent/registry/index.js");
const { createHookRuntime } = await import("../hooks/runtime.js");
const { makeTestLayer } = await import("../effect/layers.js");
const { makeRuntime } = await import("../effect/runtime.js");
const { SessionStoreTag } = await import("../effect/context.js");
const { createAgentLoopEffect } = await import("../agent/loop.js");
const { MemoryService } = await import("../compaction/service.js");
const { createRecorder } = await import("../rollout/recorder.js");

import type { ProviderId } from "../providers/config.js";
import type { AIProvider, ExecuteOptions, ExecuteResult } from "../providers/types.js";
import type { AgentEnvelope, AgentRole } from "../agent/definitions/types.js";

test.after(() => rmSync(home, { recursive: true, force: true }));

function info(id: string, streaming = false) {
  return {
    id,
    name: id,
    defaultModel: "nest-model",
    supportsStreaming: streaming,
    supportsTools: true,
    maxOutputTokens: 4096,
  };
}

// -----------------------------------------------------------------------------
// The tool list
// -----------------------------------------------------------------------------

test("an enveloped agent is offered only the tools its envelope can grant", async () => {
  const seen: string[][] = [];
  registerProvider("nest-filter" as ProviderId, {
    info: info("nest-filter"),
    create: (): AIProvider => ({
      info: info("nest-filter"),
      execute: async (options: ExecuteOptions): Promise<ExecuteResult> => {
        seen.push((options.tools ?? []).map((tool) => tool.name).sort());
        return {
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          provider: "nest-filter",
          model: "nest-model",
        };
      },
    }),
  });

  const sessionId = "envelope-filter";
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-envelope-filter-"));
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-envelope-filter-log-"));
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
      { title: "t", projectPath, provider: "nest-filter" },
      sessionId,
    );
    const loop = await runtime.runPromise(
      createAgentLoopEffect(sessionId, { maxIterations: 2 }),
    );
    const role: AgentRole = {
      name: "reader",
      prompt: "",
      tools: ["read", "bash", "write", "todowrite", "lsp"],
      envelope: { operations: ["file.read"], read: ["docs/**"] },
    };
    await loop.run({
      prompt: "go",
      sessionId,
      provider: "nest-filter",
      projectPath,
      agentMode: "build",
      role,
    });
  } finally {
    await runtime.dispose();
  }

  const offered = seen.find((names) => names.includes("read"));
  assert.ok(offered, "the loop's own tool list should contain the granted read");
  assert.ok(offered.includes("todowrite"), "session-state tools need no grant");
  assert.ok(!offered.includes("bash"), "shell is not in the envelope");
  assert.ok(!offered.includes("write"), "file.write is not in the envelope");
  assert.ok(!offered.includes("lsp"), "a target-less tool with no grant is not offered");
});

// -----------------------------------------------------------------------------
// The spawn boundary
// -----------------------------------------------------------------------------

/** Writes `<project>/.freecode/agents/<name>.md`. */
function definition(projectPath: string, name: string, frontmatter: string[]): void {
  const dir = join(projectPath, ".freecode", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    ["---", ...frontmatter, "---", "Do as you are told.", ""].join("\n"),
  );
}

/**
 * A subagent that asks to write `target` on its first turn, then stops. Chooses
 * by request shape (no tool result yet), so extra provider calls a session makes
 * — a title, a summary — cannot consume the tool call.
 */
function registerWriter(id: string, target: string) {
  registerProvider(id as ProviderId, {
    info: info(id, true),
    create: (): AIProvider => ({
      info: info(id, true),
      execute: async (): Promise<ExecuteResult> => ({
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        provider: id,
        model: "nest-model",
      }),
      stream: async function* (options: ExecuteOptions) {
        if ((options.toolResults ?? []).length === 0) {
          yield {
            type: "tool_call",
            id: "call-1",
            name: "write",
            args: { filePath: target, content: "written\n" },
          };
          yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
          yield { type: "done", stopReason: "tool_use" };
          return;
        }
        yield { type: "text_delta", delta: "moving on" };
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
        yield { type: "done", stopReason: "stop" };
      },
    }),
  });
}

/** The ToolContext the `agent` tool sees from an enveloped run. */
function spawnCtx(sessionId: string, projectPath: string, envelope: AgentEnvelope) {
  return {
    sessionId,
    cwd: projectPath,
    projectPath,
    agentMode: "danger",
    envelope,
    hooks: createHookRuntime(),
  } as never;
}

async function spawnOnce(opts: {
  sessionId: string;
  projectPath: string;
  provider: string;
  subagentType: string;
  envelope: AgentEnvelope;
}) {
  try {
    return await tools.agent.execute(
      {
        task: "t",
        prompt: "get on with it",
        subagent_type: opts.subagentType,
        model: opts.provider,
      } as never,
      spawnCtx(opts.sessionId, opts.projectPath, opts.envelope),
    );
  } finally {
    getAgentRegistry().disposeRoot(opts.sessionId);
  }
}

test("a spawn cannot widen the roots it inherits", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-envelope-narrow-"));
  // The child asks for two roots; the parent grants only one of them.
  definition(projectPath, "herdsman", [
    "name: herdsman",
    "description: Containment test",
    "mode: build",
    "tools: [write]",
    "envelope:",
    "  operations: [file.write]",
    '  write: ["docs/**", "src/**"]',
  ]);
  registerWriter("nest-narrow", "src/a.ts");

  const parentCeiling: AgentEnvelope = {
    operations: ["file.write"],
    write: ["docs/**"],
  };

  const escaped = await spawnOnce({
    sessionId: "root-narrow-escape",
    projectPath,
    provider: "nest-narrow",
    subagentType: "herdsman",
    envelope: parentCeiling,
  });
  assert.equal(escaped.success, true, "a refusal is reported to the subagent, not fatal");
  assert.equal(
    existsSync(join(projectPath, "src", "a.ts")),
    false,
    "the parent's roots bind: src/** was dropped by the intersection",
  );

  // The contained root still works, so this is narrowing and not a blanket deny.
  registerWriter("nest-narrow-kept", "docs/a.md");
  await spawnOnce({
    sessionId: "root-narrow-kept",
    projectPath,
    provider: "nest-narrow-kept",
    subagentType: "herdsman",
    envelope: parentCeiling,
  });
  assert.equal(
    existsSync(join(projectPath, "docs", "a.md")),
    true,
    "the root the parent shares is still writable",
  );
});

test("a child that declares no ceiling of its own still inherits its parent's", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-envelope-inherit-"));
  definition(projectPath, "ploughman", [
    "name: ploughman",
    "description: No ceiling of its own",
    "mode: build",
    "tools: [write]",
  ]);
  registerWriter("nest-inherit", "outside.txt");

  const result = await spawnOnce({
    sessionId: "root-inherit",
    projectPath,
    provider: "nest-inherit",
    subagentType: "ploughman",
    envelope: { operations: ["file.write"], write: ["docs/**"] },
  });

  assert.equal(result.success, true);
  assert.equal(
    existsSync(join(projectPath, "outside.txt")),
    false,
    "the parent's ceiling reaches a child that declares none",
  );
});

// -----------------------------------------------------------------------------
// The link between them: a real parent loop, and the `agent` tool it calls
// -----------------------------------------------------------------------------

/** The rollout log the layer's recorder writes. */
function readEvents(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

test("a spawn from a real loop carries the loop's ceiling into the child", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-envelope-loop-"));
  // The child declares no ceiling of its own, so only the parent's can bind it.
  definition(projectPath, "ploughman", [
    "name: ploughman",
    "description: Inherits whatever it is given",
    "mode: build",
    "tools: [write]",
  ]);

  // One provider for both loops. Which loop is calling is read off the tool
  // list it was offered: only the parent has `agent`. The first call from each
  // loop is its tool call; every later one stops the turn.
  const calls = new Map<string, number>();
  registerProvider("nest-loop" as ProviderId, {
    info: info("nest-loop", true),
    create: (): AIProvider => ({
      info: info("nest-loop", true),
      execute: async (): Promise<ExecuteResult> => ({
        content: "done",
        toolCalls: [],
        stopReason: "stop",
        provider: "nest-loop",
        model: "nest-model",
      }),
      stream: async function* (options: ExecuteOptions) {
        const child = !(options.tools ?? []).some((tool) => tool.name === "agent");
        const key = child ? "child" : "parent";
        const nth = (calls.get(key) ?? 0) + 1;
        calls.set(key, nth);
        if (nth > 1) {
          yield { type: "text_delta", delta: "moving on" };
          yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
          yield { type: "done", stopReason: "stop" };
          return;
        }
        yield child
          ? {
              type: "tool_call",
              id: "child-1",
              name: "write",
              args: { filePath: "outside.txt", content: "escaped\n" },
            }
          : {
              type: "tool_call",
              id: "parent-1",
              name: "agent",
              args: { task: "t", prompt: "write outside.txt", subagent_type: "ploughman" },
            };
        yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
        yield { type: "done", stopReason: "tool_use" };
      },
    }),
  });

  const sessionId = "envelope-loop-parent";
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-envelope-loop-log-"));
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
      recorderFactory: { forSession: (id: string) => createRecorder(id, { rolloutDir }) },
    }),
  );
  try {
    const store = await runtime.runPromise(SessionStoreTag);
    await store.createSession(
      { title: "t", projectPath, provider: "nest-loop" },
      sessionId,
    );
    const loop = await runtime.runPromise(
      createAgentLoopEffect(sessionId, { maxIterations: 3 }),
    );
    const role: AgentRole = {
      name: "root",
      prompt: "",
      // The parent declares the ceiling; `agent.spawn` is what its own call to
      // the `agent` tool needs, `file.write` is what it hands the child.
      tools: ["agent", "write"],
      envelope: { operations: ["agent.spawn", "file.write"], write: ["docs/**"] },
    };
    await loop.run({
      prompt: "delegate",
      sessionId,
      provider: "nest-loop",
      projectPath,
      agentMode: "danger",
      role,
    });
  } finally {
    getAgentRegistry().disposeRoot(sessionId);
    await runtime.dispose();
  }

  assert.equal(
    existsSync(join(projectPath, "outside.txt")),
    false,
    "the child inherits the ceiling through the loop's ToolContext",
  );

  // The child writes its own rollout log (its loop is built directly, not from
  // the test layer), so the evidence for "it tried and was refused" is there.
  const spawned = String(
    readEvents(rolloutDir).find((e) => e.type === "function.output")?.output ?? "",
  );
  const childId = /Agent id: (\S+)/.exec(spawned)?.[1];
  assert.ok(childId, "the parent must have spawned a child, not just looked busy");
  const denied = readEvents(join(home, ".freecode", "rollout", "sessions", childId)).find(
    (e) => e.type === "function.denied",
  );
  assert.ok(denied, "the child's write must be refused by the envelope, not skipped");
  assert.equal(denied.source, "envelope");
  assert.equal(denied.tool, "write");
});
