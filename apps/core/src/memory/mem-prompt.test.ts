import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { MemoryStore } from "./mem-store.js";
import {
  buildMemoryGuidanceBlock,
  MAX_MEMORY_BLOCK_BYTES,
  renderRetrievedMemories,
  renderRetrievedMemoriesDetailed,
} from "./mem-prompt.js";
import type { MemoryEntry } from "./mem-types.js";

function entry(name: string): MemoryEntry {
  return {
    name,
    type: "project",
    description: `about ${name}`,
    content: `body of ${name}`,
    createdAt: 0,
    updatedAt: 0,
  };
}

// The guidance block sits in the CACHED static system prefix. If its text ever
// varied with the store's contents, every memory save would rewrite the prefix
// and bust the whole session's prompt cache — the exact regression D2 of the
// write-path spec exists to prevent.
test("guidance block is byte-identical regardless of store contents", () => {
  const projectPath = mkdtempSync(join(tmpdir(), "mem-guidance-"));
  const store = new MemoryStore(projectPath);
  try {
    const empty = buildMemoryGuidanceBlock();

    store.save(entry("alpha"));
    store.save(entry("beta"));
    assert.equal(store.list().length, 2, "store should now be non-empty");

    assert.equal(
      buildMemoryGuidanceBlock(),
      empty,
      "guidance must not vary with stored memories",
    );
  } finally {
    rmSync(projectPath, { recursive: true, force: true });
    rmSync(dirname(store.getMemoryDir()), { recursive: true, force: true });
  }
});

test("guidance names the tool, the four types, and the exclusions", () => {
  const block = buildMemoryGuidanceBlock();
  assert.match(block, /\bmemory\b/);
  for (const type of ["user", "feedback", "project", "reference"]) {
    assert.match(block, new RegExp(`\\b${type}\\b`));
  }
  // Without an explicit exclusion list the model saves derivable facts.
  assert.match(block, /derivable|do not save|don't save/i);
});

test("guidance carries no memory bodies", () => {
  // It must stay a fixed instruction block, never a content dump — recall is
  // the graph's job (renderRetrievedMemories), not the static prefix's.
  assert.ok(
    buildMemoryGuidanceBlock().length < 1400,
    "guidance block should stay small enough to be free at cache-read rates",
  );
});

// -- D2: the injected block has a hard byte ceiling ---------------------------

function sized(name: string, contentBytes: number): MemoryEntry {
  return {
    name,
    type: "project",
    description: `about ${name}`,
    content: "x".repeat(contentBytes),
    createdAt: 0,
    updatedAt: 0,
  };
}

test("a single oversized memory renders under the cap", () => {
  const rendered = renderRetrievedMemories([sized("huge", 10_000)]);
  assert.ok(
    Buffer.byteLength(rendered, "utf-8") <= MAX_MEMORY_BLOCK_BYTES,
    `block was ${Buffer.byteLength(rendered, "utf-8")} bytes`,
  );
  assert.ok(
    rendered.includes("- huge — about huge"),
    "degrades to its description rather than vanishing",
  );
  assert.ok(!rendered.includes("x".repeat(500)), "body is not included");
});

test("the budget is spent in relevance order, not per section", () => {
  // The first entry is the most relevant and must keep its body; the later one
  // degrades even though it renders in an earlier section (user before
  // project). A per-section budget would get this backwards.
  const rendered = renderRetrievedMemories([
    sized("first", 1_200),
    { ...sized("second", 1_200), type: "user" },
  ]);
  assert.ok(rendered.includes("### first"), "most relevant keeps its body");
  assert.ok(
    rendered.includes("- second — about second"),
    "less relevant degrades",
  );
  assert.ok(
    Buffer.byteLength(rendered, "utf-8") <= MAX_MEMORY_BLOCK_BYTES,
    "and the whole block still fits",
  );
});

test("many small memories all render in full when they fit", () => {
  const entries = Array.from({ length: 5 }, (_, i) => sized(`m${i}`, 50));
  const rendered = renderRetrievedMemories(entries);
  for (let i = 0; i < 5; i++) {
    assert.ok(rendered.includes(`### m${i}`), `m${i} kept its body`);
  }
});

test("an empty set renders nothing at all, not an empty header", () => {
  assert.equal(renderRetrievedMemories([]), "");
});

test("remembered requirements outrank stale or incomplete code", () => {
  const rendered = renderRetrievedMemories([
    {
      ...entry("production-endpoint"),
      content: "Production moved to https://api.v2.example.invalid.",
    },
  ]);

  assert.match(rendered, /unless the current request supersedes/i);
  assert.match(rendered, /stale or incomplete code does not override/i);
  assert.match(rendered, /preserve every named case and unit/i);
  assert.match(rendered, /scan every recalled entry before editing/i);
  assert.match(rendered, /percentage is not a multiplier/i);
  assert.match(rendered, /current request overrides past turn-local directions/i);
  assert.doesNotMatch(rendered, /when the code disagrees, the code wins/i);
});

test("the cap never truncates mid-memory", () => {
  // Degradation is by whole entries: a body is included or it is not. Half a
  // memory would read as a complete one and mislead the model.
  const rendered = renderRetrievedMemories([
    sized("a", 1_500),
    sized("b", 1_500),
  ]);
  for (const chunk of rendered.split("### ").slice(1)) {
    const body = chunk.split("\n").slice(1).join("\n").trim();
    const xs = body.replace(/[^x]/g, "");
    if (xs.length > 0) {
      assert.equal(xs.length, 1_500, "a rendered body is whole");
    }
  }
});

test("the detailed result counts only entries represented in the prompt", () => {
  const kept = sized("kept", 100);
  const dropped = {
    ...sized("dropped", 10_000),
    description: "y".repeat(MAX_MEMORY_BLOCK_BYTES),
  };

  const rendered = renderRetrievedMemoriesDetailed([kept, dropped]);
  assert.deepEqual(rendered.entries, [kept]);
  assert.ok(rendered.text.includes("### kept"));
  assert.ok(!rendered.text.includes("dropped"));
});

test("the strict cap includes headings, footer, and multibyte text", () => {
  const entries = [
    {
      ...sized("first", 800),
      content: "🧠".repeat(200),
    },
    {
      ...sized("second", 10_000),
      description: "é".repeat(MAX_MEMORY_BLOCK_BYTES),
    },
  ];
  const rendered = renderRetrievedMemoriesDetailed(entries);
  assert.ok(
    Buffer.byteLength(rendered.text, "utf-8") <= MAX_MEMORY_BLOCK_BYTES,
    `block was ${Buffer.byteLength(rendered.text, "utf-8")} bytes`,
  );
  assert.deepEqual(rendered.entries, [entries[0]]);
});

// -- spec 2026-09-25 §6: boundary coverage ------------------------------------

const utf8 = (s: string) => Buffer.byteLength(s, "utf-8");
/** A full entry renders `### name`; a summary renders `- name — …`. */
const rendersEntry = (text: string, name: string) =>
  text.includes(`### ${name}\n`) || text.includes(`- ${name} — `);

test("the cap holds at every body size across the boundary", () => {
  // Sweep a single entry's body through the region where full → summary flips,
  // so an off-by-one in the budget check cannot hide between two sample sizes.
  let sawFull = false;
  let sawSummary = false;
  for (let n = 1_200; n <= 2_100; n++) {
    const rendered = renderRetrievedMemoriesDetailed([sized("edge", n)]);
    assert.ok(
      utf8(rendered.text) <= MAX_MEMORY_BLOCK_BYTES,
      `body ${n}: block was ${utf8(rendered.text)} bytes`,
    );
    assert.equal(rendered.entries.length, 1, `body ${n}: entry survives`);
    if (rendered.fullCount === 1) sawFull = true;
    if (rendered.summaryCount === 1) sawSummary = true;
  }
  assert.ok(sawFull && sawSummary, "the sweep crossed the full/summary boundary");
});

test("a block that fits exactly at the cap keeps the body", () => {
  // Find the largest body that still renders in full, then check it is exactly
  // at or under the cap and one more byte degrades it.
  let largest = 0;
  for (let n = 1_200; n <= 2_100; n++) {
    if (renderRetrievedMemoriesDetailed([sized("exact", n)]).fullCount === 1) {
      largest = n;
    }
  }
  const at = renderRetrievedMemoriesDetailed([sized("exact", largest)]);
  const over = renderRetrievedMemoriesDetailed([sized("exact", largest + 1)]);
  assert.ok(utf8(at.text) <= MAX_MEMORY_BLOCK_BYTES);
  assert.ok(utf8(at.text) > MAX_MEMORY_BLOCK_BYTES - 10, "boundary is tight, not padded");
  assert.equal(over.fullCount, 0);
  assert.equal(over.summaryCount, 1);
});

test("every memory type renders under its own heading within the cap", () => {
  const types = ["user", "feedback", "project", "reference"] as const;
  const entries: MemoryEntry[] = types.map((type) => ({
    ...sized(`${type}-one`, 100),
    type,
  }));
  entries.push({
    ...sized("ep-one", 100),
    type: "episode",
    happened_at: "2026-09-01",
  });
  const rendered = renderRetrievedMemoriesDetailed(entries);
  for (const heading of ["## User", "## Feedback", "## Project", "## Reference", "## Episode"]) {
    assert.ok(rendered.text.includes(heading), `${heading} present`);
  }
  assert.equal(rendered.entries.length, 5);
  assert.equal(rendered.fullCount, 4, "semantic types keep their bodies");
  assert.equal(rendered.summaryCount, 1, "an episode is always a one-liner");
  assert.ok(utf8(rendered.text) <= MAX_MEMORY_BLOCK_BYTES);
});

test("long names and descriptions degrade or drop whole, never truncate", () => {
  const longName = "n".repeat(900);
  const entries = [
    { ...sized(longName, 50), description: "d".repeat(900) },
    { ...sized("tail", 50), description: "t".repeat(900) },
  ];
  const rendered = renderRetrievedMemoriesDetailed(entries);
  assert.ok(utf8(rendered.text) <= MAX_MEMORY_BLOCK_BYTES);
  for (const entry of entries) {
    const present = rendersEntry(rendered.text, entry.name);
    const counted = rendered.entries.includes(entry);
    assert.equal(present, counted, `${entry.name.slice(0, 8)}: rendered iff counted`);
    if (!counted) {
      assert.ok(
        !rendered.text.includes(entry.description.slice(0, 50)),
        "no partial description leaks into the block",
      );
    }
  }
});

test("multi-byte text never splits a code point at the cap", () => {
  // 4-byte emoji bodies: a byte-slicing truncation would leave U+FFFD behind.
  const rendered = renderRetrievedMemoriesDetailed([
    { ...sized("emoji", 0), content: "🧠".repeat(600) },
    { ...sized("accent", 0), content: "é".repeat(600) },
  ]);
  assert.ok(utf8(rendered.text) <= MAX_MEMORY_BLOCK_BYTES);
  assert.ok(!rendered.text.includes("�"));
  assert.equal(
    rendered.fullCount + rendered.summaryCount,
    rendered.entries.length,
    "counts partition the rendered entries",
  );
});

test("omitted entries are absent from the result's identities", () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({
    ...sized(`m${i}`, 200),
    description: `desc-${i}-${"z".repeat(60)}`,
  }));
  const rendered = renderRetrievedMemoriesDetailed(entries);
  assert.ok(rendered.entries.length < entries.length, "the fixture overflows");
  for (const entry of entries) {
    assert.equal(
      rendersEntry(rendered.text, entry.name),
      rendered.entries.includes(entry),
      `${entry.name}: in text iff in entries`,
    );
  }
});

test("empty input reports zero counts", () => {
  assert.deepEqual(renderRetrievedMemoriesDetailed([]), {
    text: "",
    entries: [],
    fullCount: 0,
    summaryCount: 0,
  });
});
