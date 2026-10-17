// =============================================================================
// Phase 0 fixtures for memory fidelity (priority plan 2026-10-15 §5).
//
// The long-horizon experiment found two shapes: a fact taught last was absent in
// every trial, and a consolidation deleted the memory that carried an earlier
// fact. These fixtures reproduce both against the real write path — no
// reimplemented extractor or merger — and check that the classifier names the
// stage that lost the fact.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  classifyMissingFact,
  type ExtractionTrace,
  type MemoryWriteTrace,
} from "./failure-trace.js";
import { extractMemories } from "./extract.js";
import { consolidateMemories } from "./consolidate.js";
import { getMemoryStore } from "./mem-store.js";

function fixture(): { projectPath: string; cleanup: () => void } {
  const projectPath = mkdtempSync(join(tmpdir(), "mem-trace-"));
  const memDir = getMemoryStore(projectPath).getMemoryDir();
  return {
    projectPath,
    cleanup: () => {
      rmSync(projectPath, { recursive: true, force: true });
      rmSync(dirname(memDir), { recursive: true, force: true });
    },
  };
}

function proposal(name: string, content: string) {
  return { type: "project", name, description: `about ${name}`, content };
}

const extract = (
  projectPath: string,
  reply: string,
  trace?: MemoryWriteTrace,
) =>
  extractMemories({
    transcript: "user: here is what the team does",
    projectPath,
    provider: "test",
    complete: async () => reply,
    trace,
  });

function traceWithLive(live: string[]): MemoryWriteTrace {
  const extraction: ExtractionTrace = {
    candidates: live,
    accepted: live,
    replaced: [],
    skipped: [],
    live,
  };
  return { extraction };
}

// -----------------------------------------------------------------------------
// Classification — one fixture per cause, so a cause can never be reported for
// a stage that did not lose the fact.
// -----------------------------------------------------------------------------

test("a stage that was never recorded is unmeasured, not present", () => {
  assert.equal(classifyMissingFact("SSO is required"), "unmeasured");
});

test("a fact live but never retrieved is a retrieval miss", () => {
  const fact = "SSO is required for all internal tools";
  assert.equal(
    classifyMissingFact(fact, { trace: traceWithLive([fact]), retrieved: [] }),
    "retrieval_miss",
  );
});

test("a fact retrieved but dropped by the judge is a judge rejection", () => {
  const fact = "SSO is required for all internal tools";
  assert.equal(
    classifyMissingFact(fact, {
      trace: traceWithLive([fact]),
      retrieved: [fact],
      judged: [],
    }),
    "judge_rejection",
  );
});

test("a fact kept by the judge but cut by the byte budget is a rendering drop", () => {
  const fact = "SSO is required for all internal tools";
  assert.equal(
    classifyMissingFact(fact, {
      trace: traceWithLive([fact]),
      retrieved: [fact],
      judged: [fact],
      rendered: [],
    }),
    "rendering_budget_drop",
  );
});

test("a fact that reaches the rendered block is present", () => {
  const fact = "SSO is required for all internal tools";
  assert.equal(
    classifyMissingFact(fact, {
      trace: traceWithLive([fact]),
      retrieved: [fact],
      judged: [fact],
      rendered: [fact],
    }),
    "present",
  );
});

// -----------------------------------------------------------------------------
// Shape 1 — "the last taught fact was absent in all three trials". The plan's
// two hypotheses are extraction omission and a same-name save overwriting.
// -----------------------------------------------------------------------------

test("a fact the extractor never proposed is an extraction omission", async () => {
  const { projectPath, cleanup } = fixture();
  const trace: MemoryWriteTrace = {};
  try {
    await extract(projectPath, "[]", trace);
    assert.equal(trace.extraction?.candidates.length, 0);
    assert.deepEqual(trace.extraction?.live, []);
    assert.equal(
      classifyMissingFact("SSO is required", { trace }),
      "extraction_omission",
    );
  } finally {
    cleanup();
  }
});

test("the last taught fact past the per-run cap is an extraction omission", async () => {
  const { projectPath, cleanup } = fixture();
  const trace: MemoryWriteTrace = {};
  try {
    await extract(
      projectPath,
      JSON.stringify([
        proposal("deploy-cadence", "We always deploy on Fridays"),
        proposal("release-checklist", "The release checklist lives in docs"),
        proposal("sso-provider", "SSO is required for all internal tools"),
        proposal("campaign-deadline", "The campaign deadline moved to Nov 3"),
      ]),
      trace,
    );

    assert.equal(trace.extraction?.accepted.length, 3);
    assert.deepEqual(trace.extraction?.skipped, [
      { body: "The campaign deadline moved to Nov 3", reason: "cap" },
    ]);
    assert.equal(
      classifyMissingFact("The campaign deadline moved to Nov 3", { trace }),
      "extraction_omission",
    );
  } finally {
    cleanup();
  }
});

test("a low-overlap same-name save preserves both facts", async () => {
  const { projectPath, cleanup } = fixture();
  const first: MemoryWriteTrace = {};
  const second: MemoryWriteTrace = {};
  try {
    await extract(
      projectPath,
      JSON.stringify([
        proposal("sso-provider", "SSO is required for all internal tools"),
      ]),
      first,
    );
    await extract(
      projectPath,
      JSON.stringify([proposal("sso-provider", "The SSO provider is Okta")]),
      second,
    );

    assert.deepEqual(second.extraction?.replaced, [
      {
        name: "sso-provider",
        before: "SSO is required for all internal tools",
        after: "SSO is required for all internal tools\n\nThe SSO provider is Okta",
      },
    ]);
    assert.equal(second.extraction?.live.length, 1);
    assert.ok(second.extraction?.live[0]?.includes("SSO is required for all internal tools"));
    assert.ok(second.extraction?.live[0]?.includes("The SSO provider is Okta"));
    assert.equal(
      classifyMissingFact("SSO is required for all internal tools", {
        trace: second,
      }),
      "present",
    );
    assert.equal(
      classifyMissingFact("The SSO provider is Okta", { trace: second }),
      "present",
    );
  } finally {
    cleanup();
  }
});

test("re-proposing an unchanged memory is skipped, not lost", async () => {
  const { projectPath, cleanup } = fixture();
  const trace: MemoryWriteTrace = {};
  const reply = JSON.stringify([
    proposal("sso-provider", "SSO is required for all internal tools"),
  ]);
  try {
    await extract(projectPath, reply, {});
    await extract(projectPath, reply, trace);

    assert.deepEqual(trace.extraction?.skipped, [
      { body: "SSO is required for all internal tools", reason: "unchanged" },
    ]);
    assert.equal(
      classifyMissingFact("SSO is required for all internal tools", { trace }),
      "present",
    );
  } finally {
    cleanup();
  }
});

// -----------------------------------------------------------------------------
// Shape 2 — "consolidation merged and deleted memories, after which an earlier
// fact was missing or wrong".
// -----------------------------------------------------------------------------

const TWO_MEMORIES = [
  {
    name: "sqlite-choice",
    content: "The thread store is a single SQLite file",
  },
  { name: "deploy-cadence", content: "We always deploy on Fridays" },
];

function seedTwo(projectPath: string): void {
  const store = getMemoryStore(projectPath);
  for (const m of TWO_MEMORIES) {
    store.save({
      name: m.name,
      type: "project",
      description: `about ${m.name}`,
      content: m.content,
      createdAt: 0,
      updatedAt: 0,
    });
  }
}

const merge = (projectPath: string, content: string, trace: MemoryWriteTrace) =>
  consolidateMemories({
    projectPath,
    provider: "test",
    prompt: "irrelevant",
    shownNames: new Set(TWO_MEMORIES.map((m) => m.name)),
    trace,
    complete: async () =>
      JSON.stringify({
        merges: [
          {
            into: "sqlite-choice",
            supersedes: ["deploy-cadence"],
            description: "The thread store and the deploy cadence",
            content,
          },
        ],
        episode: null,
        promote: [],
      }),
  });

test("a merge that drops a claim is refused, and its sources stay live", async () => {
  const { projectPath, cleanup } = fixture();
  const trace: MemoryWriteTrace = {};
  try {
    seedTwo(projectPath);
    const result = await merge(
      projectPath,
      "Deploys happen on Fridays.",
      trace,
    );

    assert.equal(result.merged, 0, "the lossy merge is skipped");
    assert.equal(result.skippedMerges, 1);
    assert.deepEqual(trace.consolidation?.deleted, []);
    assert.deepEqual(trace.consolidation?.live.slice().sort(), [
      "The thread store is a single SQLite file",
      "We always deploy on Fridays",
    ]);
    // The claim the merge would have dropped is still there to be read.
    assert.equal(
      classifyMissingFact("single SQLite file", { trace }),
      "present",
    );
  } finally {
    cleanup();
  }
});

test("a retention deletion still loses a fact, and the classifier names it", async () => {
  const { projectPath, cleanup } = fixture();
  const store = getMemoryStore(projectPath);
  const trace: MemoryWriteTrace = {};
  try {
    // Retention is the deletion path the Phase 2 merge guard does not govern:
    // an episode over the cap is dropped once a successful call has had its
    // chance to fold anything durable out of it. When it did not, the fact dies
    // in consolidation — which is exactly what the classifier has to say out
    // loud, so the next safeguard has somewhere to start.
    store.save({
      name: "session-2026-10-01",
      type: "episode",
      description: "a session",
      content: "The retry ceiling is three attempts",
      createdAt: 0,
      updatedAt: 0,
      happened_at: "2026-10-01",
    });

    await consolidateMemories({
      projectPath,
      provider: "test",
      prompt: "irrelevant",
      shownNames: new Set(["session-2026-10-01"]),
      overflowEpisodes: ["session-2026-10-01"],
      trace,
      complete: async () =>
        JSON.stringify({ merges: [], episode: null, promote: [] }),
    });

    assert.deepEqual(trace.consolidation?.sources, [
      "The retry ceiling is three attempts",
    ]);
    assert.deepEqual(trace.consolidation?.deleted, ["session-2026-10-01"]);
    assert.deepEqual(trace.consolidation?.live, []);
    assert.equal(
      classifyMissingFact("The retry ceiling is three attempts", { trace }),
      "consolidation_omission",
    );
  } finally {
    cleanup();
  }
});

test("a merge that carries the fact is not a loss", async () => {
  const { projectPath, cleanup } = fixture();
  const trace: MemoryWriteTrace = {};
  try {
    seedTwo(projectPath);
    await merge(
      projectPath,
      "The thread store is a single SQLite file. Deploys happen on Fridays.",
      trace,
    );

    assert.deepEqual(trace.consolidation?.deleted, ["deploy-cadence"]);
    assert.equal(
      classifyMissingFact("single SQLite file", { trace }),
      "present",
    );
    // Reworded by the merge ("Deploys happen on Fridays") and still present:
    // presence is what the classifier checks, not survival of the old body.
    assert.equal(classifyMissingFact("on Fridays", { trace }), "present");
  } finally {
    cleanup();
  }
});
