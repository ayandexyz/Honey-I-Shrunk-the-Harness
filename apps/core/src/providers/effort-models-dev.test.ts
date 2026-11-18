import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Same isolation as models-dev-vision.test.ts: a fixture cache, never the
// developer's real ~/.freecode/cache or the network.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-effort-models-dev-"));
process.env.FREECODE_MODELS_CACHE_FILE = path.join(dir, "models-dev.json");
fs.writeFileSync(
  process.env.FREECODE_MODELS_CACHE_FILE,
  JSON.stringify({
    timestamp: Date.now(),
    data: [
      {
        id: "zai-coding-plan",
        name: "Z.AI Coding Plan",
        models: [
          {
            id: "glm-5.2",
            name: "GLM-5.2",
            // The real models.dev value for this exact model, live-verified
            // 2026-11-17 — narrower than, and different from, this entry's
            // hand-set catalogue fallback (["low","high","max"]).
            reasoning: true,
            reasoningOptions: [{ type: "effort", values: ["none", "high", "xhigh"] }],
          },
          {
            id: "no-reasoning-data",
            name: "No reasoning data",
            reasoning: true,
            // reasoningOptions omitted — models.dev has nothing more specific.
          },
        ],
      },
    ],
  }),
);

import { applyEffort } from "./effort.js";
import { findModelReasoningOptions } from "../models-dev.js";

test("findModelReasoningOptions: reads the effort values straight off the fixture cache", () => {
  assert.deepEqual(findModelReasoningOptions("zai-coding-plan", "glm-5.2"), [
    { type: "effort", values: ["none", "high", "xhigh"] },
  ]);
});

test("findModelReasoningOptions: case-insensitive, matching every other per-model lookup in models-dev.ts", () => {
  assert.deepEqual(findModelReasoningOptions("zai-coding-plan", "GLM-5.2"), [
    { type: "effort", values: ["none", "high", "xhigh"] },
  ]);
});

test("findModelReasoningOptions: undefined for an unknown provider or model", () => {
  assert.equal(findModelReasoningOptions("no-such-provider", "x"), undefined);
  assert.equal(findModelReasoningOptions("zai-coding-plan", "no-such-model"), undefined);
});

test("applyEffort: models.dev's own value set overrides the catalogue's hand-set fallback", () => {
  const opts: { providerOptions?: Record<string, unknown> } = {};
  // The catalogue fallback has no "xhigh"; models.dev's real data for this
  // exact model does, so the request goes out as asked.
  applyEffort(
    opts,
    { id: "zai-coding-plan", effortFamily: "openai-compatible", effortValues: ["low", "high", "max"] },
    "xhigh",
    "glm-5.2",
  );
  assert.deepEqual(opts.providerOptions, { "zai-coding-plan": { reasoningEffort: "xhigh" } });
});

test("applyEffort: models.dev never raises effort — nothing at or below the request falls back to the catalogue", () => {
  const opts: { providerOptions?: Record<string, unknown> } = {};
  // models.dev lists ["none","high","xhigh"] for glm-5.2 ("none" is dropped),
  // so clamping "low" against it would send "high". "low" was live-verified
  // on this model (2026-11-17), and the catalogue fallback has it.
  applyEffort(
    opts,
    { id: "zai-coding-plan", effortFamily: "openai-compatible", effortValues: ["low", "high", "max"] },
    "low",
    "glm-5.2",
  );
  assert.deepEqual(opts.providerOptions, { "zai-coding-plan": { reasoningEffort: "low" } });
});

test("applyEffort: no modelId means no models.dev lookup — the catalogue fallback alone decides", () => {
  const opts: { providerOptions?: Record<string, unknown> } = {};
  applyEffort(
    opts,
    { id: "zai-coding-plan", effortFamily: "openai-compatible", effortValues: ["low", "high", "max"] },
    "low",
  );
  assert.deepEqual(opts.providerOptions, { "zai-coding-plan": { reasoningEffort: "low" } });
});

test("applyEffort: a model models.dev has no reasoning_options for falls back to the catalogue's effortValues", () => {
  const opts: { providerOptions?: Record<string, unknown> } = {};
  applyEffort(
    opts,
    { id: "zai-coding-plan", effortFamily: "openai-compatible", effortValues: ["low", "high", "max"] },
    "medium",
    "no-reasoning-data",
  );
  // effortValues ["low","high","max"] has no "medium"; the clamp prefers the
  // cheaper neighbor, same as the catalogue-only path.
  assert.deepEqual(opts.providerOptions, { "zai-coding-plan": { reasoningEffort: "low" } });
});

test("applyEffort: an unknown model id falls back the same way as no reasoning data", () => {
  const opts: { providerOptions?: Record<string, unknown> } = {};
  applyEffort(
    opts,
    { id: "zai-coding-plan", effortFamily: "openai-compatible", effortValues: ["low", "high", "max"] },
    "medium",
    "glm-some-future-model-not-in-the-fixture",
  );
  assert.deepEqual(opts.providerOptions, { "zai-coding-plan": { reasoningEffort: "low" } });
});

test("findModelReasoningOptions: a rewritten cache file is re-read, not served from the memo", () => {
  const file = process.env.FREECODE_MODELS_CACHE_FILE!;
  const before = fs.readFileSync(file, "utf-8");
  assert.ok(findModelReasoningOptions("zai-coding-plan", "glm-5.2"));
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        timestamp: Date.now(),
        data: [{ id: "zai-coding-plan", name: "Z", models: [{ id: "glm-5.2", name: "G" }] }],
      }),
    );
    assert.equal(findModelReasoningOptions("zai-coding-plan", "glm-5.2"), undefined);
  } finally {
    fs.writeFileSync(file, before);
  }
});
