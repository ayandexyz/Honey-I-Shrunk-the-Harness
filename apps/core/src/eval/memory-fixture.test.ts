import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "memfix-home-"));

import { getMemoryStore, MemoryStore } from "../memory/mem-store.js";
import { getMemoryGraphService } from "../memory/graph/index.js";
import {
  isolateTrialMemory,
  memoryEnvironmentForCase,
  memoryPolicyForCase,
  seedMemories,
} from "./memory-fixture.js";

test("seeds exactly the fixture into the project's own store, and removes it", async () => {
  const project = mkdtempSync(join(tmpdir(), "memfix-proj-"));
  try {
    const cleanup = await seedMemories(project, [
      {
        type: "project",
        name: "uses-pnpm",
        description: "package manager",
        content: "Use pnpm.",
        tags: ["tooling"],
      },
      {
        type: "feedback",
        name: "no-force-push",
        description: "git",
        content: "Never force-push.",
      },
    ]);
    const store = new MemoryStore(project);
    const names = store
      .list()
      .map((e) => `${e.type}/${e.name}`)
      .sort();
    assert.deepEqual(names, ["feedback/no-force-push", "project/uses-pnpm"]);
    assert.deepEqual(store.load("uses-pnpm", "project")?.tags, ["tooling"]);

    cleanup();
    assert.equal(existsSync(store.getMemoryDir()), false);
    assert.deepEqual(new MemoryStore(project).list(), []);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("two projects never share a fixture", async () => {
  const a = mkdtempSync(join(tmpdir(), "memfix-a-"));
  const b = mkdtempSync(join(tmpdir(), "memfix-b-"));
  try {
    const cleanup = await seedMemories(a, [
      { type: "project", name: "only-in-a", description: "d", content: "c" },
    ]);
    assert.deepEqual(new MemoryStore(b).list(), []);
    cleanup();
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("the index is built at seed time, so the first request is not a cold miss", async () => {
  const project = mkdtempSync(join(tmpdir(), "memfix-warm-"));
  try {
    const cleanup = await seedMemories(project, [
      {
        type: "project",
        name: "uses-pnpm",
        description: "This repo uses pnpm as its package manager",
        content: "Install dependencies with pnpm install.",
      },
    ]);
    const { getMemoryGraphService } = await import("../memory/graph/index.js");
    const service = getMemoryGraphService(project);
    const first = await service.prepareMemories(
      "s",
      "which package manager do we use to install dependencies",
    );
    assert.deepEqual(
      first.map((e) => e.name),
      ["uses-pnpm"],
    );
    assert.equal(service.preparationFor("s").state, "fresh");
    cleanup();
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("an ordinary trial sees an empty private store, never live project memory", async () => {
  const project = mkdtempSync(join(tmpdir(), "memfix-isolated-"));
  const live = getMemoryStore(project);
  live.save({
    type: "project",
    name: "developer-secret",
    description: "must stay outside eval",
    content: "live developer corpus",
    createdAt: 1,
    updatedAt: 1,
  });
  const liveDir = live.getMemoryDir();
  const isolation = isolateTrialMemory(project, {});
  const isolated = getMemoryStore(project);
  const isolatedRoot = dirname(isolated.getMemoryDir());
  try {
    assert.notEqual(isolated.getMemoryDir(), liveDir);
    assert.deepEqual(isolated.list(), []);
    isolated.save({
      type: "project",
      name: "trial-only",
      description: "temporary",
      content: "temporary",
      createdAt: 1,
      updatedAt: 1,
    });
    await getMemoryGraphService(project).retrieve("temporary", { limit: 1 });
    assert.equal(existsSync(join(isolated.getMemoryDir(), ".graph")), true);
  } finally {
    isolation.cleanup();
  }

  assert.equal(
    existsSync(isolatedRoot),
    false,
    "corpus and graph sidecars are removed",
  );
  assert.deepEqual(
    getMemoryStore(project)
      .list()
      .map((entry) => entry.name),
    ["developer-secret"],
  );
  rmSync(dirname(liveDir), { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

test("reports stable memory policy fingerprints without fixture bodies", () => {
  const memory = {
    type: "project" as const,
    name: "package-manager",
    description: "tooling",
    content: "Use pnpm and never expose this body in a report.",
  };
  const empty = memoryPolicyForCase({});
  const fixture = memoryPolicyForCase({ memories: [memory] });
  const changed = memoryPolicyForCase({
    memories: [{ ...memory, content: "Use npm." }],
  });
  const learning = memoryPolicyForCase({
    sessions: [{ prompt: "Teach the agent a preference." }],
  });

  assert.deepEqual(empty, { policy: "empty", fixture: "empty-v1" });
  assert.equal(fixture.policy, "fixture");
  assert.notEqual(fixture.fixture, changed.fixture);
  assert.equal(fixture.fixture.includes(memory.content), false);
  assert.equal(learning.policy, "learning");
});

test("memory writers are frozen unless the case explicitly learns", () => {
  assert.deepEqual(memoryEnvironmentForCase({}), {
    FREECODE_DISABLE_MEMORY_EXTRACTION: "1",
    FREECODE_DISABLE_MEMORY_CONSOLIDATION: "1",
  });
  assert.deepEqual(memoryEnvironmentForCase({ sessions: [] }), {
    FREECODE_DISABLE_MEMORY_CONSOLIDATION: "1",
  });
});
