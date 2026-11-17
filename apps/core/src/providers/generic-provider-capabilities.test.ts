import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildGenerateOptions } from "./generic-provider.js";

process.env.FREECODE_ANTHROPIC_AUTH = "api-key";

// Separate file from generic-provider.test.ts on purpose: that file's fixture
// is deliberately empty (`data: []`, "models.dev has no opinion") so its
// effort assertions exercise only the catalogue-level fallback. This one
// needs a model that explicitly declares `temperature: false` / `tool_call:
// false`, to prove buildGenerateOptions actually suppresses those params —
// not just that modelSupportsTemperature/modelSupportsToolCalls answer
// correctly in isolation (models-dev-capabilities.test.ts covers that).
const modelsDevCacheDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "freecode-generic-provider-capabilities-"),
);
process.env.FREECODE_MODELS_CACHE_FILE = path.join(
  modelsDevCacheDir,
  "models-dev.json",
);
fs.writeFileSync(
  process.env.FREECODE_MODELS_CACHE_FILE,
  JSON.stringify({
    timestamp: Date.now(),
    data: [
      {
        id: "anthropic",
        name: "Anthropic",
        models: [
          {
            id: "no-temp-no-tools-model",
            name: "No Temp No Tools",
            temperature: false,
            toolCall: false,
          },
        ],
      },
    ],
  }),
);

import { resolveCatalogue } from "./catalogue.js";
import type { ProviderCatalogueEntry } from "./catalogue.js";

const modelHandle = { __model: true };

function entry(id: string): ProviderCatalogueEntry {
  const found = resolveCatalogue().find((e) => e.id === id);
  assert.ok(found, `${id} is not in the resolved catalogue`);
  return found;
}

const anthropicEntry = entry("anthropic");
const tools = [
  { name: "read", description: "r", parameters: { type: "object", properties: {} } },
] as any;

test("temperature is suppressed for a model models.dev explicitly marks temperature:false", () => {
  const opts = buildGenerateOptions(anthropicEntry, modelHandle, {
    prompt: "hi",
    model: "no-temp-no-tools-model",
    temperature: 0.7,
  });
  assert.equal(opts.temperature, undefined);
});

test("temperature passes through unchanged for a model with no declared gate", () => {
  const opts = buildGenerateOptions(anthropicEntry, modelHandle, {
    prompt: "hi",
    model: "some-other-model",
    temperature: 0.7,
  });
  assert.equal(opts.temperature, 0.7);
});

test("tools are suppressed for a model models.dev explicitly marks tool_call:false", () => {
  const opts = buildGenerateOptions(anthropicEntry, modelHandle, {
    prompt: "hi",
    model: "no-temp-no-tools-model",
    tools,
  });
  assert.equal(opts.tools, undefined);
});

test("tools pass through unchanged for a model with no declared gate", () => {
  const opts = buildGenerateOptions(anthropicEntry, modelHandle, {
    prompt: "hi",
    model: "some-other-model",
    tools,
  });
  assert.ok(opts.tools && Object.keys(opts.tools).length > 0);
});

test("no resolved model (neither opts.model nor a catalogue default) fails open on both gates", () => {
  const bareEntry: ProviderCatalogueEntry = { ...anthropicEntry, defaultModel: undefined };
  const opts = buildGenerateOptions(bareEntry, modelHandle, {
    prompt: "hi",
    temperature: 0.7,
    tools,
  });
  assert.equal(opts.temperature, 0.7);
  assert.ok(opts.tools && Object.keys(opts.tools).length > 0);
});
