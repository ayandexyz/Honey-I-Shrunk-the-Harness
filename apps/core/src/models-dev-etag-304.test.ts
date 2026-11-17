import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";

// opencode-style conditional refetch (packages/core/src/models-dev.ts's
// `fetchPath`): a TTL-expired disk cache still carries a usable `etag`, and
// sending it as `If-None-Match` lets models.dev answer 304 instead of
// freecode re-downloading and re-parsing the multi-MB catalogue for a body
// that didn't change.

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

test("a 304 response reuses the stale disk cache instead of re-downloading", async (t) => {
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

  const stalePayload = {
    data: [
      { id: "acme", name: "Acme", description: "Acme", models: [{ id: "acme-1", name: "Acme One" }] },
    ],
    timestamp: Date.now() - 10 * 60 * 1000, // past the 5-minute TTL
    etag: '"etag-abc"',
  };
  fs.writeFileSync(cacheFile, JSON.stringify(stalePayload));

  let hits = 0;
  let sawEtag: string | undefined;
  await withServer(
    (req, res) => {
      hits++;
      sawEtag = req.headers["if-none-match"] as string | undefined;
      res.statusCode = 304;
      res.end();
    },
    async (url) => {
      process.env.FREECODE_MODELS_URL = url;
      const { getProviders } = await import("./models-dev.js");
      const providers = await getProviders(false);

      assert.equal(hits, 1, "expected exactly one conditional request");
      assert.equal(sawEtag, stalePayload.etag, "expected the stale cache's etag on If-None-Match");
      assert.equal(providers[0]?.id, "acme", "304 should reuse the stale cache's data");

      const onDisk = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      assert.ok(
        onDisk.timestamp > stalePayload.timestamp,
        "timestamp should refresh on 304 so the next check isn't immediately stale again",
      );
      assert.equal(onDisk.etag, stalePayload.etag);
    },
  );
});
