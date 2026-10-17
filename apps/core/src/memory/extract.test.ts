import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { extractMemories, MAX_SAVES_PER_RUN } from "./extract.js";
import { getMemoryStore } from "./mem-store.js";
import type { MemoryWriteTrace } from "./failure-trace.js";
import { bus } from "../bus/index.js";

function fixture(): { projectPath: string; cleanup: () => void } {
  const projectPath = mkdtempSync(join(tmpdir(), "mem-extract-"));
  const memDir = getMemoryStore(projectPath).getMemoryDir();
  return {
    projectPath,
    cleanup: () => {
      rmSync(projectPath, { recursive: true, force: true });
      rmSync(dirname(memDir), { recursive: true, force: true });
    },
  };
}

function proposal(name: string) {
  return {
    type: "project",
    name,
    description: `about ${name}`,
    content: `content for ${name}`,
  };
}

const TRANSCRIPT = "user: we always deploy on Fridays\nassistant: noted";

test("saves proposals up to the per-run cap and drops the rest", async () => {
  const { projectPath, cleanup } = fixture();
  try {
    const five = [1, 2, 3, 4, 5].map((i) => proposal(`fact-${i}`));
    const saved = await extractMemories({
      transcript: TRANSCRIPT,
      projectPath,
      provider: "anthropic",
      complete: async () => JSON.stringify(five),
    });

    assert.equal(saved, MAX_SAVES_PER_RUN);
    assert.equal(getMemoryStore(projectPath).list().length, MAX_SAVES_PER_RUN);
  } finally {
    cleanup();
  }
});

test("when capped, prioritizes a fact from the latest user message", async () => {
  const { projectPath, cleanup } = fixture();
  try {
    const proposals = [
      proposal("old-one"),
      proposal("old-two"),
      proposal("old-three"),
      {
        type: "project",
        name: "ap-northeast-rate",
        description: "ap-northeast-1 is 10 percent",
        content: "The region table also needs ap-northeast-1 at 10 percent.",
      },
    ];
    await extractMemories({
      transcript:
        "user: the region table also needs ap-northeast-1 at 10 percent\nassistant: noted",
      projectPath,
      provider: "anthropic",
      complete: async () => JSON.stringify(proposals),
    });
    const names = getMemoryStore(projectPath).list().map((entry) => entry.name);
    assert.ok(names.includes("ap-northeast-rate"));
    assert.equal(names.length, MAX_SAVES_PER_RUN);
  } finally {
    cleanup();
  }
});

test("a throwing completion is swallowed and saves nothing", async () => {
  const { projectPath, cleanup } = fixture();
  try {
    const saved = await extractMemories({
      transcript: TRANSCRIPT,
      projectPath,
      provider: "anthropic",
      complete: async () => {
        throw new Error("provider exploded");
      },
    });
    assert.equal(saved, 0);
    assert.equal(getMemoryStore(projectPath).list().length, 0);
  } finally {
    cleanup();
  }
});

test("malformed output saves nothing and does not throw", async () => {
  const { projectPath, cleanup } = fixture();
  try {
    const saved = await extractMemories({
      transcript: TRANSCRIPT,
      projectPath,
      provider: "anthropic",
      complete: async () => "I could not find anything worth saving, sorry!",
    });
    assert.equal(saved, 0);
  } finally {
    cleanup();
  }
});

test("an empty transcript never calls the provider", async () => {
  const { projectPath, cleanup } = fixture();
  try {
    let called = false;
    const saved = await extractMemories({
      transcript: "   ",
      projectPath,
      provider: "anthropic",
      complete: async () => {
        called = true;
        return "[]";
      },
    });
    assert.equal(called, false);
    assert.equal(saved, 0);
  } finally {
    cleanup();
  }
});

test("the extractor treats no-edit acknowledgement language as turn-local", async () => {
  const { projectPath, cleanup } = fixture();
  let system = "";
  try {
    await extractMemories({
      transcript:
        "user: Production moved to api.v2. Don't edit yet, just acknowledge.\nassistant: noted",
      projectPath,
      provider: "anthropic",
      complete: async (prompt) => {
        system = prompt;
        return "[]";
      },
    });

    assert.match(system, /apply only to that turn/i);
    assert.match(system, /never save them/i);
    assert.match(system, /save the durable fact underneath/i);
    assert.match(system, /concrete enduring rule, identifier, value, or correction/i);
  } finally {
    cleanup();
  }
});

test("a proposal carrying a secret is skipped, its siblings still save", async () => {
  const { projectPath, cleanup } = fixture();
  try {
    const saved = await extractMemories({
      transcript: TRANSCRIPT,
      projectPath,
      provider: "anthropic",
      complete: async () =>
        JSON.stringify([
          {
            type: "reference",
            name: "deploy-key",
            description: "the deploy key",
            content: "key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
          },
          proposal("safe-fact"),
        ]),
    });

    assert.equal(saved, 1);
    const names = getMemoryStore(projectPath)
      .list()
      .map((e) => e.name);
    assert.deepEqual(names, ["safe-fact"]);
  } finally {
    cleanup();
  }
});

test("proposals fenced in a markdown code block are still parsed", async () => {
  const { projectPath, cleanup } = fixture();
  try {
    const saved = await extractMemories({
      transcript: TRANSCRIPT,
      projectPath,
      provider: "anthropic",
      complete: async () =>
        "Here is what I found:\n\n```json\n" +
        JSON.stringify([proposal("fenced")]) +
        "\n```\n",
    });
    assert.equal(saved, 1);
  } finally {
    cleanup();
  }
});

test("proposals with an unknown type or missing fields are skipped", async () => {
  const { projectPath, cleanup } = fixture();
  try {
    const saved = await extractMemories({
      transcript: TRANSCRIPT,
      projectPath,
      provider: "anthropic",
      complete: async () =>
        JSON.stringify([
          { type: "notes", name: "a", description: "d", content: "c" },
          { type: "project", name: "b", description: "d" },
          proposal("valid"),
        ]),
    });
    assert.equal(saved, 1);
  } finally {
    cleanup();
  }
});

// Writing notes about someone without telling them is the wrong default, so
// the bus notice is part of the contract, not a nicety.
function captureMemorySaved(): { events: unknown[]; stop: () => void } {
  const events: unknown[] = [];
  const stop = bus.subscribeAll((e) => {
    if ((e as { type: string }).type === "memory.saved") events.push(e);
  });
  return { events, stop };
}

test("announces saved memories on the bus so the user is told", async () => {
  const { projectPath, cleanup } = fixture();
  const cap = captureMemorySaved();
  try {
    await extractMemories({
      transcript: TRANSCRIPT,
      projectPath,
      provider: "anthropic",
      sessionId: "S1",
      complete: async () => JSON.stringify([proposal("deploy-cadence")]),
    });
    assert.equal(cap.events.length, 1);
    assert.deepEqual(cap.events[0], {
      type: "memory.saved",
      sessionId: "S1",
      memories: [{ type: "project", name: "deploy-cadence" }],
    });
  } finally {
    cap.stop();
    cleanup();
  }
});

test("stays silent when nothing was saved", async () => {
  const { projectPath, cleanup } = fixture();
  const cap = captureMemorySaved();
  try {
    await extractMemories({
      transcript: TRANSCRIPT,
      projectPath,
      provider: "anthropic",
      sessionId: "S1",
      complete: async () => "[]",
    });
    assert.equal(cap.events.length, 0, "an empty extraction must not notify");
  } finally {
    cap.stop();
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Multi-turn additive facts under one topic. Extraction is idempotent on
// (type, name) — a later turn updates the entry — so the failure to guard
// against is a rewrite that carries less than what is already stored, with
// nothing new in its place.
// -----------------------------------------------------------------------------

function withContent(name: string, content: string) {
  return { type: "project", name, description: `about ${name}`, content };
}

const teach = (
  projectPath: string,
  ...entries: Array<{
    type: string;
    name: string;
    description: string;
    content: string;
  }>
) =>
  extractMemories({
    transcript: TRANSCRIPT,
    projectPath,
    provider: "anthropic",
    complete: async () => JSON.stringify(entries),
  });

const TWO_RULES = "We always deploy on Fridays and never on Mondays";

test("a rewrite that only subtracts facts is refused, and the entry keeps them", async () => {
  const { projectPath, cleanup } = fixture();
  try {
    assert.equal(
      await teach(projectPath, withContent("deploy-cadence", TWO_RULES)),
      1,
    );
    // The next turn's extractor reuses the topic and drops the second rule. A
    // stored fact is not the extractor's to forget, so the write is refused.
    assert.equal(
      await teach(
        projectPath,
        withContent("deploy-cadence", "We always deploy on Fridays"),
      ),
      0,
    );
    assert.equal(
      getMemoryStore(projectPath).load("deploy-cadence", "project")?.content,
      TWO_RULES,
    );
  } finally {
    cleanup();
  }
});

test("a same-name rewrite that adds a fact still updates the entry", async () => {
  const { projectPath, cleanup } = fixture();
  try {
    await teach(
      projectPath,
      withContent("deploy-cadence", "We always deploy on Fridays"),
    );
    assert.equal(
      await teach(projectPath, withContent("deploy-cadence", TWO_RULES)),
      1,
      "learning more is an update, not a loss",
    );
    assert.equal(
      getMemoryStore(projectPath).load("deploy-cadence", "project")?.content,
      TWO_RULES,
    );
  } finally {
    cleanup();
  }
});

test("a rewrite that restates the facts in new words still updates the entry", async () => {
  const { projectPath, cleanup } = fixture();
  try {
    await teach(
      projectPath,
      withContent("deploy-cadence", "The campaign deadline is Nov 3"),
    );
    assert.equal(
      await teach(
        projectPath,
        withContent("deploy-cadence", "The campaign deadline moved to Dec 1"),
      ),
      1,
    );
    assert.equal(
      getMemoryStore(projectPath).load("deploy-cadence", "project")?.content,
      "The campaign deadline moved to Dec 1",
    );
  } finally {
    cleanup();
  }
});

test("a low-overlap same-name proposal preserves the earlier fact", async () => {
  const { projectPath, cleanup } = fixture();
  try {
    await teach(projectPath, withContent("sso-provider", "SSO is required for all internal tools"));
    assert.equal(
      await teach(projectPath, withContent("sso-provider", "The SSO provider is Okta")),
      1,
    );
    const content = getMemoryStore(projectPath).load("sso-provider", "project")?.content ?? "";
    assert.ok(content.includes("SSO is required for all internal tools"));
    assert.ok(content.includes("The SSO provider is Okta"));
  } finally {
    cleanup();
  }
});

test("a refused rewrite is recorded instead of vanishing", async () => {
  const { projectPath, cleanup } = fixture();
  const trace: MemoryWriteTrace = {};
  try {
    await teach(projectPath, withContent("deploy-cadence", TWO_RULES));
    await extractMemories({
      transcript: TRANSCRIPT,
      projectPath,
      provider: "anthropic",
      complete: async () =>
        JSON.stringify([
          withContent("deploy-cadence", "We always deploy on Fridays"),
        ]),
      trace,
    });
    assert.deepEqual(trace.extraction?.skipped, [
      { body: "We always deploy on Fridays", reason: "lossy" },
    ]);
  } finally {
    cleanup();
  }
});
