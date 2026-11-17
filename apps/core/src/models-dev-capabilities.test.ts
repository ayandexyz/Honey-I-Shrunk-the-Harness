import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { modelSupportsTemperature, modelSupportsToolCalls } from "./models-dev.js";

// Same shape as models-dev-vision.test.ts's fixture: a models.dev `false` is
// data, an absent field is "no opinion" — both must be distinguishable, and
// only the explicit `false` may ever suppress a param freecode already sends.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-capabilities-"));
process.env.FREECODE_MODELS_CACHE_FILE = path.join(dir, "models-dev.json");
fs.writeFileSync(
  process.env.FREECODE_MODELS_CACHE_FILE,
  JSON.stringify({
    timestamp: Date.now(),
    data: [
      {
        id: "anthropic",
        name: "Anthropic",
        models: [
          { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", temperature: true, toolCall: true },
          { id: "no-opinion-model", name: "No Opinion" },
        ],
      },
      {
        id: "empiriolabs",
        name: "Empirio Labs",
        models: [{ id: "kimi-k3", name: "Kimi K3", temperature: false, toolCall: false }],
      },
    ],
  }),
);

test("modelSupportsTemperature: true for a model that declares support", () => {
  assert.equal(modelSupportsTemperature("anthropic", "claude-sonnet-4-6"), true);
});

test("modelSupportsTemperature: false for a model that explicitly declares no support", () => {
  assert.equal(modelSupportsTemperature("empiriolabs", "kimi-k3"), false);
});

test("modelSupportsTemperature: fails OPEN (true) when models.dev has no opinion", () => {
  assert.equal(modelSupportsTemperature("anthropic", "no-opinion-model"), true);
});

test("modelSupportsTemperature: fails OPEN for an unknown model or provider", () => {
  assert.equal(modelSupportsTemperature("anthropic", "no-such-model"), true);
  assert.equal(modelSupportsTemperature("no-such-provider", "x"), true);
});

test("modelSupportsTemperature: matches model ids case-insensitively", () => {
  assert.equal(modelSupportsTemperature("empiriolabs", "KIMI-K3"), false);
});

test("modelSupportsToolCalls: true for a model that declares support", () => {
  assert.equal(modelSupportsToolCalls("anthropic", "claude-sonnet-4-6"), true);
});

test("modelSupportsToolCalls: false for a model that explicitly declares no support", () => {
  assert.equal(modelSupportsToolCalls("empiriolabs", "kimi-k3"), false);
});

test("modelSupportsToolCalls: fails OPEN (true) when models.dev has no opinion", () => {
  assert.equal(modelSupportsToolCalls("anthropic", "no-opinion-model"), true);
});

test("modelSupportsToolCalls: fails OPEN for an unknown model or provider", () => {
  assert.equal(modelSupportsToolCalls("anthropic", "no-such-model"), true);
  assert.equal(modelSupportsToolCalls("no-such-provider", "x"), true);
});
