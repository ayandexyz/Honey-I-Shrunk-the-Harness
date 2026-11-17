import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";

// Exercises parseCatalogue's actual transform of models.dev's raw wire
// format (snake_case reasoning_options, possibly carrying a literal null in
// an effort values array) into ProviderModel.reasoning/reasoningOptions —
// the step effort-models-dev.test.ts doesn't cover, since that file writes
// the already-parsed shape directly into a fixture cache. Same loopback-http
// pattern as models-dev-fetch.test.ts, duplicated rather than imported since
// neither file exports its helpers.

async function withServer(
  handler: http.RequestListener,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await run(`http://127.0.0.1:${port}/api.json`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function freshEnv(t: { after: (fn: () => void) => void }): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-modelsdev-reasoning-"));
  const prevUrl = process.env.FREECODE_MODELS_URL;
  const prevCache = process.env.FREECODE_MODELS_CACHE_FILE;
  process.env.FREECODE_MODELS_CACHE_FILE = path.join(dir, "models-dev.json");
  t.after(() => {
    if (prevUrl === undefined) delete process.env.FREECODE_MODELS_URL;
    else process.env.FREECODE_MODELS_URL = prevUrl;
    if (prevCache === undefined) delete process.env.FREECODE_MODELS_CACHE_FILE;
    else process.env.FREECODE_MODELS_CACHE_FILE = prevCache;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const BODY = JSON.stringify({
  "z-ai": {
    name: "Z.AI",
    npm: "@ai-sdk/openai-compatible",
    models: {
      "glm-5.2": {
        name: "GLM-5.2",
        reasoning: true,
        // The real wire shape: a literal null marking an unsupported slot,
        // same as models.dev actually serves it for some models.
        reasoning_options: [{ type: "effort", values: ["none", "high", null, "xhigh"] }],
      },
      "glm-5.1": {
        name: "GLM-5.1",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
      },
      "glm-4": {
        name: "GLM-4",
        reasoning: false,
        // No reasoning_options at all for a non-reasoning model.
      },
      "glm-unknown-shape": {
        name: "GLM unknown shape",
        reasoning: true,
        // A future field models.dev might add that this parser doesn't
        // recognize yet — must degrade to "no options", not throw.
        reasoning_options: [{ type: "something-new-in-2027" }],
      },
    },
  },
});

async function fetchedProviders(t: { after: (fn: () => void) => void }) {
  freshEnv(t);
  let providers: Awaited<ReturnType<typeof import("./models-dev.js").getProviders>> | undefined;
  await withServer(
    (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(BODY);
    },
    async (url) => {
      process.env.FREECODE_MODELS_URL = url;
      const { getProviders } = await import("./models-dev.js");
      providers = await getProviders(true);
    },
  );
  return providers!.find((p) => p.id === "z-ai")!.models;
}

test("parseCatalogue: reasoning and reasoning_options survive the raw-JSON round trip", async (t) => {
  const models = await fetchedProviders(t);
  const glm52 = models.find((m) => m.id === "glm-5.2");
  assert.equal(glm52?.reasoning, true);
  assert.deepEqual(glm52?.reasoningOptions, [
    { type: "effort", values: ["none", "high", "xhigh"] },
  ]);
});

test("parseCatalogue: a literal null in an effort values array is dropped, not kept as a string", async (t) => {
  const models = await fetchedProviders(t);
  const glm52 = models.find((m) => m.id === "glm-5.2");
  const effortOption = glm52?.reasoningOptions?.find((o) => o.type === "effort");
  assert.ok(effortOption?.type === "effort");
  assert.ok(!effortOption.values.includes(null as unknown as string));
  assert.equal(effortOption.values.length, 3);
});

test("parseCatalogue: a toggle-type option round-trips with no values field", async (t) => {
  const models = await fetchedProviders(t);
  const glm51 = models.find((m) => m.id === "glm-5.1");
  assert.deepEqual(glm51?.reasoningOptions, [{ type: "toggle" }]);
});

test("parseCatalogue: reasoning:false and an absent reasoning_options both parse cleanly", async (t) => {
  const models = await fetchedProviders(t);
  const glm4 = models.find((m) => m.id === "glm-4");
  assert.equal(glm4?.reasoning, false);
  assert.equal(glm4?.reasoningOptions, undefined);
});

test("parseCatalogue: an unrecognized option type degrades to 'no options', not a throw", async (t) => {
  const models = await fetchedProviders(t);
  const unknown = models.find((m) => m.id === "glm-unknown-shape");
  assert.equal(unknown?.reasoning, true);
  assert.equal(unknown?.reasoningOptions, undefined);
});

test("findModelReasoningOptions: reads the real parsed-and-cached data back synchronously", async (t) => {
  await fetchedProviders(t); // populates the disk cache this reads from
  const { findModelReasoningOptions } = await import("./models-dev.js");
  assert.deepEqual(findModelReasoningOptions("z-ai", "glm-5.2"), [
    { type: "effort", values: ["none", "high", "xhigh"] },
  ]);
});
