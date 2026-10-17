import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { ShadowGit } from "../../apps/core/src/checkpoint/shadow-git.js";
import { SessionManager } from "../../apps/core/src/session/manager.js";
import {
  createSessionStore,
  type SerializedMessage,
  type SessionStore,
} from "../../apps/core/src/session/store.js";
import { StreamingAssistantMessage } from "../../apps/tui/src/components/message-row.js";
import { resultFromSamples, sample, type BenchmarkResult } from "./metrics.js";

const exec = promisify(execFile);

export interface FixtureOptions {
  iterations: number;
  warmup: number;
  repoRoot: string;
}

interface RpcLine {
  id?: number | string;
  result?: unknown;
  error?: { message?: string };
}

interface RpcProcess {
  child: ChildProcessWithoutNullStreams;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

function message(id: string, size = 320): SerializedMessage {
  return {
    id,
    role: Number(id.replace(/\D/g, "")) % 2 === 0 ? "assistant" : "user",
    parts: [{ type: "text", content: `${id}: ${"x".repeat(size)}` }],
    timestamp: Number(id.replace(/\D/g, "")) || 1,
  };
}

function makeMessages(count: number, size = 320): SerializedMessage[] {
  return Array.from({ length: count }, (_, index) =>
    message(`m-${index}`, size),
  );
}

async function seedSession(
  store: SessionStore,
  projectPath: string,
  id: string,
  messages: SerializedMessage[],
): Promise<number> {
  await store.createSession(
    { title: id, projectPath, provider: "benchmark" },
    id,
  );
  await store.replaceMessages(id, messages, projectPath);
  return Buffer.byteLength(
    messages.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}

function serverCommand(repoRoot: string): {
  command: string;
  args: string[];
  mode: string;
} {
  const dist = join(repoRoot, "apps/core/dist/server.js");
  if (existsSync(dist)) {
    return { command: process.execPath, args: [dist], mode: "compiled" };
  }
  return {
    command: join(repoRoot, "node_modules/.bin/tsx"),
    args: [join(repoRoot, "apps/core/src/server.ts")],
    mode: "tsx-source",
  };
}

function startRpcProcess(repoRoot: string, fixtureRoot: string): RpcProcess {
  const launch = serverCommand(repoRoot);
  const home = join(fixtureRoot, "home");
  const project = join(fixtureRoot, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const child = spawn(launch.command, launch.args, {
    cwd: project,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      FREECODE_HOME: join(home, ".freecode"),
      FREECODE_CHECKPOINTS: "0",
      FREECODE_DISABLE_MEMORY_EXTRACTION: "1",
      FREECODE_DISABLE_MEMORY_CONSOLIDATION: "1",
      FREECODE_DISABLE_MEMORY_RECALL: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let nextId = 1;
  let buffer = "";
  let stderr = "";
  const pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      let parsed: RpcLine;
      try {
        parsed = JSON.parse(line) as RpcLine;
      } catch {
        continue;
      }
      if (typeof parsed.id !== "number") continue;
      const waiter = pending.get(parsed.id);
      if (!waiter) continue;
      pending.delete(parsed.id);
      clearTimeout(waiter.timer);
      if (parsed.error)
        waiter.reject(new Error(parsed.error.message ?? "RPC failed"));
      else waiter.resolve(parsed.result);
    }
  });
  child.on("exit", (code) => {
    const error = new Error(
      `benchmark backend exited (${code ?? "signal"})${stderr ? `: ${stderr.trim()}` : ""}`,
    );
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  });

  return {
    child,
    request(method, params) {
      const id = nextId++;
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(new Error(`benchmark RPC timed out: ${method}`));
        }, 15_000);
        pending.set(id, { resolve: resolveRequest, reject, timer });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });
    },
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          done();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          done();
        });
      });
    },
  };
}

async function startupFixtures(
  options: FixtureOptions,
): Promise<BenchmarkResult[]> {
  const startup: number[] = [];
  const firstInput: number[] = [];
  const total = options.warmup + options.iterations;
  const mode = serverCommand(options.repoRoot).mode;

  for (let i = 0; i < total; i++) {
    const root = mkdtempSync(join(tmpdir(), "freecode-perf-start-"));
    const started = performance.now();
    const rpc = startRpcProcess(options.repoRoot, root);
    try {
      await rpc.request("config.get");
      const readyAt = performance.now();
      const inputStarted = performance.now();
      await rpc.request("session.start", {
        projectPath: join(root, "project"),
        provider: "benchmark",
        agentMode: "build",
      });
      const inputDone = performance.now();
      if (i >= options.warmup) {
        startup.push(readyAt - started);
        firstInput.push(inputDone - inputStarted);
      }
    } finally {
      await rpc.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  return [
    resultFromSamples("cold_backend_ready", "backend", startup, {
      processMode: mode,
      rpc: "config.get",
    }),
    resultFromSamples("first_session_start", "backend", firstInput, {
      processMode: mode,
      filesystemWrites: 2,
    }),
  ];
}

function markdownFixture(bytes: number): string {
  const block = [
    "## Streaming fixture",
    "",
    "| item | value |",
    "| --- | ---: |",
    "| café | 42 |",
    "",
    "```ts",
    "export const answer = 42;",
    "```",
    "",
  ].join("\n");
  let content = block
    .repeat(Math.ceil(bytes / Buffer.byteLength(block)))
    .slice(0, bytes);
  while (Buffer.byteLength(content) > bytes) content = content.slice(0, -1);
  content += "x".repeat(bytes - Buffer.byteLength(content));
  return content;
}

function utf8Chunks(content: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of content) {
    const characterBytes = Buffer.byteLength(character);
    if (current && currentBytes + characterBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function streamFixture(
  options: FixtureOptions,
  chunkBytes: number,
  totalBytes: number,
): Promise<BenchmarkResult[]> {
  const frontend: number[] = [];
  const backend: number[] = [];
  const endToEnd: number[] = [];
  const content = markdownFixture(totalBytes);
  const scheduledChunks = utf8Chunks(content, chunkBytes);
  const chunks = scheduledChunks.length;
  const total = options.warmup + options.iterations;
  let markdownRebuilds = 0;

  for (let iteration = 0; iteration < total; iteration++) {
    const component = new StreamingAssistantMessage();
    let backendMs = 0;
    let frontendMs = 0;
    const started = performance.now();
    for (const delta of scheduledChunks) {
      const backendStarted = performance.now();
      const wire = JSON.stringify({ type: "text_delta", delta });
      const event = JSON.parse(wire) as { delta: string };
      backendMs += performance.now() - backendStarted;

      const frontendStarted = performance.now();
      component.append(event.delta);
      component.render(100);
      frontendMs += performance.now() - frontendStarted;
    }
    const finalizeStarted = performance.now();
    component.finalize(content);
    component.render(100);
    frontendMs += performance.now() - finalizeStarted;
    markdownRebuilds = component.markdownRebuilds;
    const elapsed = performance.now() - started;
    if (iteration >= options.warmup) {
      backend.push(backendMs);
      frontend.push(frontendMs);
      endToEnd.push(elapsed);
    }
  }

  const name = `stream_${totalBytes}b_${chunkBytes}b_chunks`;
  const work = {
    bytesStreamed: Buffer.byteLength(content),
    chunks,
    maxChunkBytes: chunkBytes,
    markdownRenders: markdownRebuilds,
    renderRequests: chunks + 1,
  };
  return [
    resultFromSamples(name, "backend", backend, work),
    resultFromSamples(name, "frontend", frontend, work),
    resultFromSamples(name, "end_to_end", endToEnd, work),
  ];
}

async function promptToVisible(
  options: FixtureOptions,
): Promise<BenchmarkResult[]> {
  const provider: number[] = [];
  const backend: number[] = [];
  const frontend: number[] = [];
  const endToEnd: number[] = [];
  const total = options.warmup + options.iterations;
  const providerDelayMs = 2;

  for (let i = 0; i < total; i++) {
    const component = new StreamingAssistantMessage();
    const started = performance.now();
    const providerStarted = performance.now();
    await new Promise((resolveDelay) =>
      setTimeout(resolveDelay, providerDelayMs),
    );
    const providerDone = performance.now();

    const backendStarted = performance.now();
    const wire = JSON.stringify({
      type: "text_delta",
      delta: "First visible text",
    });
    const event = JSON.parse(wire) as { delta: string };
    const backendDone = performance.now();

    const frontendStarted = performance.now();
    component.append(event.delta);
    component.render(100);
    const visibleAt = performance.now();
    if (i >= options.warmup) {
      provider.push(providerDone - providerStarted);
      backend.push(backendDone - backendStarted);
      frontend.push(visibleAt - frontendStarted);
      endToEnd.push(visibleAt - started);
    }
  }

  const work = {
    chunks: 1,
    visibleCharacters: 18,
    configuredDelayMs: providerDelayMs,
  };
  return [
    resultFromSamples(
      "prompt_to_first_visible_text",
      "provider",
      provider,
      work,
    ),
    resultFromSamples("prompt_to_first_visible_text", "backend", backend, work),
    resultFromSamples(
      "prompt_to_first_visible_text",
      "frontend",
      frontend,
      work,
    ),
    resultFromSamples(
      "prompt_to_first_visible_text",
      "end_to_end",
      endToEnd,
      work,
    ),
  ];
}

async function sessionFixtures(
  options: FixtureOptions,
  root: string,
): Promise<BenchmarkResult[]> {
  const baseDir = join(root, "session-home");
  const projectPath = join(root, "project");
  await mkdir(projectPath, { recursive: true });
  const store = await createSessionStore(baseDir);
  const small = makeMessages(24);
  const large = makeMessages(2_400);
  const smallBytes = await seedSession(store, projectPath, "small", small);
  const largeBytes = await seedSession(store, projectPath, "large", large);
  const results: BenchmarkResult[] = [];

  for (const fixture of [
    { id: "small", entries: small.length, bytes: smallBytes },
    { id: "large", entries: large.length, bytes: largeBytes },
  ]) {
    results.push(
      await sample(
        {
          name: `session_resume_${fixture.id}`,
          layer: "backend",
          iterations: options.iterations,
          warmup: options.warmup,
          work: {
            entriesConverted: fixture.entries,
            bytesParsed: fixture.bytes,
          },
        },
        async () => {
          const manager = new SessionManager(store);
          const resumed = await manager.resume(fixture.id);
          if (resumed.messages.length !== fixture.entries) {
            throw new Error(`resume fixture lost messages: ${fixture.id}`);
          }
        },
      ),
    );
  }

  results.push(
    await sample(
      {
        name: "history_load_unchanged",
        layer: "backend",
        iterations: options.iterations,
        warmup: options.warmup,
        work: {
          entriesConverted: large.length,
          bytesParsed: largeBytes,
          mutations: 0,
        },
      },
      async () => {
        await store.getMessages("large", projectPath);
      },
    ),
  );

  let mutation = 0;
  results.push(
    await sample(
      {
        name: "history_load_after_append",
        layer: "backend",
        iterations: options.iterations,
        warmup: options.warmup,
        work: {
          entriesConverted: large.length + 1,
          bytesParsed:
            largeBytes +
            Buffer.byteLength(JSON.stringify(message("mutation", 320)) + "\n"),
          mutations: 1,
        },
      },
      async () => {
        mutation++;
        const appended = message(`mutation-${mutation}`, 320);
        await store.replaceMessages("large", [...large, appended], projectPath);
        await store.getMessages("large", projectPath);
      },
    ),
  );

  return results;
}

async function createGitFixture(
  root: string,
  name: string,
  files: number,
): Promise<string> {
  const project = join(root, name);
  await mkdir(project, { recursive: true });
  for (let i = 0; i < files; i++) {
    const dir = join(project, `dir-${Math.floor(i / 100)}`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `file-${i}.ts`),
      `export const value${i} = ${i};\n`,
    );
  }
  await exec("git", ["init", "-q"], { cwd: project });
  writeFileSync(join(project, ".gitignore"), "node_modules\n");
  return project;
}

async function checkpointFixtures(
  options: FixtureOptions,
  root: string,
): Promise<BenchmarkResult[]> {
  const previous = process.env.FREECODE_SNAPSHOTS_HOME;
  const results: BenchmarkResult[] = [];
  try {
    for (const fixture of [
      { name: "small", files: 25 },
      { name: "large", files: 1_000 },
    ]) {
      const project = await createGitFixture(
        root,
        `git-${fixture.name}`,
        fixture.files,
      );
      let run = 0;
      results.push(
        await sample(
          {
            name: `checkpoint_capture_${fixture.name}`,
            layer: "backend",
            iterations: options.iterations,
            warmup: options.warmup,
            work: {
              filesScanned: fixture.files + 1,
              filesStatted: fixture.files + 1,
            },
          },
          async () => {
            process.env.FREECODE_SNAPSHOTS_HOME = join(
              root,
              `snapshots-${fixture.name}-${run++}`,
            );
            const snapshot = await new ShadowGit(project).capture();
            if (!snapshot)
              throw new Error(`checkpoint capture failed: ${fixture.name}`);
          },
        ),
      );
    }
  } finally {
    if (previous === undefined) delete process.env.FREECODE_SNAPSHOTS_HOME;
    else process.env.FREECODE_SNAPSHOTS_HOME = previous;
  }
  return results;
}

export async function runFixtures(
  options: FixtureOptions,
): Promise<BenchmarkResult[]> {
  const root = mkdtempSync(join(tmpdir(), "freecode-local-perf-"));
  try {
    return [
      ...(await startupFixtures(options)),
      ...(await promptToVisible(options)),
      ...(await streamFixture(options, 128, 16 * 1024)),
      ...(await streamFixture(options, 1_024, 16 * 1024)),
      ...(await sessionFixtures(options, root)),
      ...(await checkpointFixtures(options, root)),
    ];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
