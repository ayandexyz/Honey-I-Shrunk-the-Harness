// =============================================================================
// The agent envelope at the execution site: a definition's ceiling refuses a
// call the mode would have allowed — including in `danger` mode, which bypasses
// everything else — and leaves a `function.denied` naming the envelope.
//
// Runs the real loop against a fake provider with the recorder pointed at a temp
// dir, so the refusal is read back from the rollout log, never inferred.
// Spec: docs/specs/2026-09-27-agent-control-and-definitions.md §5.4, §5.7, §5.9
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestLayer } from "../effect/layers.js";
import { makeRuntime } from "../effect/runtime.js";
import { SessionStoreTag } from "../effect/context.js";
import { createAgentLoopEffect } from "./loop.js";
import { MemoryService } from "../compaction/service.js";
import { createRecorder } from "../rollout/recorder.js";
import { registerProvider } from "../providers/registry.js";
import { registerHook, unregisterAllHooks } from "../hooks/registry.js";
import type { ProviderId } from "../providers/config.js";
import type { AIProvider, ExecuteResult } from "../providers/types.js";
import type { AgentEnvelope, AgentRole } from "./definitions/types.js";

function info(id: string) {
  return {
    id,
    name: id,
    defaultModel: "fake-model",
    supportsStreaming: false,
    supportsTools: true,
    maxOutputTokens: 4096,
  };
}

/** A provider that asks for one tool call on its first turn, then stops. */
function registerCaller(
  provider: string,
  call: { name: string; args: Record<string, unknown> },
) {
  let turn = 0;
  registerProvider(provider as ProviderId, {
    info: info(provider),
    create: (): AIProvider => ({
      info: info(provider),
      execute: async (): Promise<ExecuteResult> => {
        turn += 1;
        if (turn === 1) {
          return {
            content: "calling",
            toolCalls: [{ name: call.name, args: call.args, id: "call-1" }],
            stopReason: "tool_use",
            provider,
            model: "fake-model",
          };
        }
        return {
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          provider,
          model: "fake-model",
        };
      },
    }),
  });
}

function readEvents(dir: string): Array<Record<string, unknown>> {
  const file = join(dir, "events.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function denials(dir: string): Array<Record<string, unknown>> {
  return readEvents(dir).filter((e) => e.type === "function.denied");
}

async function runOnce(opts: {
  sessionId: string;
  provider: string;
  projectPath: string;
  rolloutDir: string;
  call: { name: string; args: Record<string, unknown> };
  envelope: AgentEnvelope;
  tools: string[];
  mode?: "build" | "danger";
  autoApproveAsks?: boolean;
  settings?: Record<string, unknown>;
}) {
  registerCaller(opts.provider, opts.call);
  if (opts.settings) {
    mkdirSync(join(opts.projectPath, ".freecode"), { recursive: true });
    writeFileSync(
      join(opts.projectPath, ".freecode", "settings.json"),
      JSON.stringify(opts.settings),
    );
  }
  const runtime = makeRuntime(
    makeTestLayer({
      memoryFactory: {
        forSession: () =>
          new MemoryService(opts.sessionId, {
            storage: {
              save: () => {},
              load: () => undefined,
              listSessions: () => [],
              delete: () => {},
            } as never,
          }),
      },
      recorderFactory: {
        forSession: (id: string) => createRecorder(id, { rolloutDir: opts.rolloutDir }),
      },
    }),
  );
  try {
    const store = await runtime.runPromise(SessionStoreTag);
    await store.createSession(
      { title: "t", projectPath: opts.projectPath, provider: opts.provider },
      opts.sessionId,
    );
    const loop = await runtime.runPromise(
      createAgentLoopEffect(opts.sessionId, {
        maxIterations: 2,
        autoApproveAsks: opts.autoApproveAsks,
      }),
    );
    // What `agent/definitions/resolve.ts` hands a spawn: the definition's role,
    // envelope included.
    const role: AgentRole = {
      name: "herdsman",
      prompt: "",
      tools: opts.tools,
      envelope: opts.envelope,
    };
    await loop.run({
      prompt: "go",
      sessionId: opts.sessionId,
      provider: opts.provider,
      projectPath: opts.projectPath,
      agentMode: opts.mode ?? "build",
      role,
    });
  } finally {
    await runtime.dispose();
  }
}

test("a write inside the envelope lands", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-envelope-in-"));
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-envelope-in-log-"));
  await runOnce({
    sessionId: "envelope-inside",
    provider: "envelope-inside",
    projectPath,
    rolloutDir,
    call: { name: "write", args: { filePath: "docs/a.md", content: "kept\n" } },
    envelope: { operations: ["file.write"], write: ["docs/**"] },
    tools: ["write"],
    autoApproveAsks: true,
  });
  assert.equal(existsSync(join(projectPath, "docs", "a.md")), true, "in-envelope write");
  assert.deepEqual(denials(rolloutDir), []);
});

test("a write outside the write roots is refused and recorded against the envelope", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-envelope-out-"));
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-envelope-out-log-"));
  await runOnce({
    sessionId: "envelope-outside",
    provider: "envelope-outside",
    projectPath,
    rolloutDir,
    call: { name: "write", args: { filePath: "outside.txt", content: "escaped\n" } },
    envelope: { operations: ["file.write"], write: ["docs/**"] },
    tools: ["write"],
    mode: "danger",
  });
  assert.equal(existsSync(join(projectPath, "outside.txt")), false, "no write happened");

  const [denied] = denials(rolloutDir);
  assert.ok(denied, "a refusal must leave a function.denied behind");
  assert.equal(denied.source, "envelope");
  assert.equal(denied.tool, "write");
  assert.match(String(denied.reason), /docs\/\*\*/);
});

test("an operation the envelope withholds is refused even in danger mode", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-envelope-shell-"));
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-envelope-shell-log-"));
  await runOnce({
    sessionId: "envelope-shell",
    provider: "envelope-shell",
    projectPath,
    rolloutDir,
    call: { name: "bash", args: { command: "touch escaped-by-shell" } },
    envelope: { operations: ["file.write"], write: ["docs/**"] },
    tools: ["bash", "write"],
    mode: "danger",
  });
  assert.equal(
    existsSync(join(projectPath, "escaped-by-shell")),
    false,
    "the shell must not have run",
  );

  const [denied] = denials(rolloutDir);
  assert.ok(denied, "a refusal must leave a function.denied behind");
  assert.equal(denied.source, "envelope");
  assert.match(String(denied.reason), /shell/);
});

test("a symlink out of the roots is refused, so the write lands nowhere", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-envelope-link-"));
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-envelope-link-log-"));
  mkdirSync(join(projectPath, "docs"));
  mkdirSync(join(projectPath, "outside"));
  symlinkSync(join(projectPath, "outside"), join(projectPath, "docs", "escape"));

  await runOnce({
    sessionId: "envelope-symlink",
    provider: "envelope-symlink",
    projectPath,
    rolloutDir,
    call: {
      name: "write",
      args: { filePath: "docs/escape/evil.txt", content: "through the link\n" },
    },
    envelope: { operations: ["file.write"], write: ["docs/**"] },
    tools: ["write"],
    mode: "danger",
  });
  assert.equal(
    existsSync(join(projectPath, "outside", "evil.txt")),
    false,
    "the symlink must not carry the write out of the roots",
  );

  const [denied] = denials(rolloutDir);
  assert.ok(denied, "a refusal must leave a function.denied behind");
  assert.equal(denied.source, "envelope");
});

test("a plain danger run still bypasses deny rules — the ceiling is the only thing above it", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-envelope-danger-"));
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-envelope-danger-log-"));
  await runOnce({
    sessionId: "envelope-danger-nocap",
    provider: "envelope-danger-nocap",
    projectPath,
    rolloutDir,
    call: { name: "write", args: { filePath: "outside.txt", content: "allowed\n" } },
    envelope: { operations: ["file.write"], write: ["**"] },
    tools: ["write"],
    mode: "danger",
    settings: { permissions: { deny: ["Write"] } },
  });
  assert.equal(
    existsSync(join(projectPath, "outside.txt")),
    true,
    "danger mode bypasses rules unless a definition declared a ceiling",
  );
  assert.deepEqual(denials(rolloutDir), []);
});

test("the read axis is enforced too — the file's contents never reach the model", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-envelope-read-"));
  mkdirSync(join(projectPath, "docs"));
  writeFileSync(join(projectPath, "outside.txt"), "AKIA-SECRET\n");
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-envelope-read-log-"));
  await runOnce({
    sessionId: "envelope-read-outside",
    provider: "envelope-read-outside",
    projectPath,
    rolloutDir,
    call: { name: "read", args: { filePath: "outside.txt" } },
    envelope: { operations: ["file.read"], read: ["docs/**"] },
    tools: ["read"],
    mode: "danger",
  });

  const events = readEvents(rolloutDir);
  assert.equal(denials(rolloutDir)[0]?.source, "envelope");
  assert.equal(
    events.filter((e) => e.type === "function.call").length,
    0,
    "the tool must not run: a read's whole product is what it returns",
  );
});

test("a path tool called without its argument is judged at the project root", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-envelope-noarg-"));
  mkdirSync(join(projectPath, "docs"));
  writeFileSync(join(projectPath, "docs", "note.md"), "inside the roots\n");
  writeFileSync(join(projectPath, "outside.txt"), "AKIA-SECRET\n");
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-envelope-noarg-log-"));
  await runOnce({
    sessionId: "envelope-noarg",
    provider: "envelope-noarg",
    projectPath,
    rolloutDir,
    // `grep` with no `path` searches the working directory — the project root,
    // which is outside `docs/**`, so omitting the argument cannot buy a read.
    call: { name: "grep", args: { pattern: "AKIA" } },
    envelope: { operations: ["file.read"], read: ["docs/**"] },
    tools: ["grep"],
    mode: "danger",
  });
  assert.equal(denials(rolloutDir)[0]?.source, "envelope");
  assert.equal(
    readEvents(rolloutDir).filter((e) => e.type === "function.call").length,
    0,
  );
});

test("a permission hook cannot rewrite a call out of the envelope", async () => {
  const projectPath = mkdtempSync(join(tmpdir(), "freecode-envelope-rewrite-"));
  mkdirSync(join(projectPath, "docs"));
  const rolloutDir = mkdtempSync(join(tmpdir(), "freecode-envelope-rewrite-log-"));
  registerHook("PermissionRequest", "rewriter", {
    type: "callback",
    callback: async () => ({ action: "modify", modifiedInput: { filePath: "outside.txt" } }),
  });
  try {
    await runOnce({
      sessionId: "envelope-rewrite",
      provider: "envelope-rewrite",
      projectPath,
      rolloutDir,
      call: { name: "write", args: { filePath: "docs/a.md", content: "x\n" } },
      envelope: { operations: ["file.write"], write: ["docs/**"] },
      tools: ["write"],
      mode: "build",
      autoApproveAsks: true,
    });
  } finally {
    unregisterAllHooks("settings");
  }

  assert.equal(
    existsSync(join(projectPath, "outside.txt")),
    false,
    "a hook runs after the ceiling and must not be able to widen it",
  );
  assert.equal(
    existsSync(join(projectPath, "docs", "a.md")),
    false,
    "the rewritten call is refused outright, not silently run with the old args",
  );
  assert.equal(denials(rolloutDir)[0]?.source, "envelope");
});
