import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { modelSupportsImages } from "./models-dev.js";

// They assert the *shape* of the decision, not a hardcoded provider list — the
// bug this replaced was a hardcoded allowlist that silently dropped images for
// every other provider. A fixture catalogue, not the developer's cache or the
// network: offline (the bench's `--network none` checks) the real one is empty
// and the two "true" cases failed on every untouched commit.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-vision-"));
process.env.FREECODE_MODELS_CACHE_FILE = path.join(dir, "models-dev.json");
fs.writeFileSync(
  process.env.FREECODE_MODELS_CACHE_FILE,
  JSON.stringify({
    timestamp: Date.now(),
    data: [
      {
        id: "anthropic",
        name: "Anthropic",
        models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", inputModalities: ["text", "image", "pdf"] }],
      },
      { id: "minimax", name: "MiniMax", models: [{ id: "MiniMax-M2", name: "MiniMax-M2", inputModalities: ["text"] }] },
    ],
  }),
);

test("modelSupportsImages: true for a model whose modalities include image", async () => {
  assert.equal(
    await modelSupportsImages("anthropic", "claude-sonnet-4-6"),
    true,
  );
});

test("modelSupportsImages: false for a text-only model", async () => {
  // MiniMax reports modalities.input = ["text"].
  assert.equal(await modelSupportsImages("minimax", "MiniMax-M2"), false);
});

test("modelSupportsImages: matches model ids case-insensitively", async () => {
  assert.equal(
    await modelSupportsImages("anthropic", "CLAUDE-SONNET-4-6"),
    true,
  );
});

test("modelSupportsImages: fails closed for unknown models and providers", async () => {
  assert.equal(await modelSupportsImages("anthropic", "no-such-model"), false);
  assert.equal(await modelSupportsImages("no-such-provider", "x"), false);
  assert.equal(await modelSupportsImages("anthropic", undefined), false);
});
