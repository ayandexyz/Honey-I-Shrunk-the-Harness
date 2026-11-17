import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";

// Separate file from models-dev-etag-304.test.ts on purpose: both exercise
// `getProviders`'s module-level in-memory cache, which persists across
// `test()` blocks that share a process (node:test isolates per *file*, not
// per block), so the 304 case and this 200-replaces-it case would otherwise
// see each other's cache instead of a clean module.

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

test("a 200 with a new etag replaces the cached data and etag", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-modelsdev-etag-"));
  const cacheFile = path.join(dir, "models-dev.json");
  const prevUrl = process.env.FREECODE_MODELS_URL;
  const prevCache = process.env.FREECODE_MODELS_CACHE_FILE;
  const prevTimeout = process.env.FREECODE_MODELS_TIMEOUT_MS;
  process.env.FREECODE_MODELS_CACHE_FILE = cacheFile;
  process.env.FREECODE_MODELS_TIMEOUT_MS = "300";
  t.after(() => {
    if (prevUrl === undefined) delete process.env.FREECODE_MODELS_URL;
    else process.env.FREECODE_MODELS_URL = prevUrl;
    if (prevCache === undefined) delete process.env.FREECODE_MODELS_CACHE_FILE;
    else process.env.FREECODE_MODELS_CACHE_FILE = prevCache;
    if (prevTimeout === undefined) delete process.env.FREECODE_MODELS_TIMEOUT_MS;
    else process.env.FREECODE_MODELS_TIMEOUT_MS = prevTimeout;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  fs.writeFileSync(
    cacheFile,
    JSON.stringify({
      data: [{ id: "old", name: "Old", description: "Old", models: [] }],
      timestamp: Date.now() - 10 * 60 * 1000,
      etag: '"etag-old"',
    }),
  );

  const BODY = JSON.stringify({
    acme: { name: "Acme", models: { "acme-1": { name: "Acme One" } } },
  });

  await withServer(
    (req, res) => {
      assert.equal(req.headers["if-none-match"], '"etag-old"');
      res.setHeader("content-type", "application/json");
      res.setHeader("etag", '"etag-new"');
      res.end(BODY);
    },
    async (url) => {
      process.env.FREECODE_MODELS_URL = url;
      const { getProviders } = await import("./models-dev.js");
      const providers = await getProviders(false);

      assert.equal(providers.find((p) => p.id === "acme")?.name, "Acme");
      assert.equal(providers.find((p) => p.id === "old"), undefined);

      const onDisk = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      assert.equal(onDisk.etag, '"etag-new"');
    },
  );
});
