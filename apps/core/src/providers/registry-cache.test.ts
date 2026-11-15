// getProvider() caches one instance per id (TODO.md: a fresh instance per call
// re-imported the SDK and re-read config.json from disk every turn), but a
// credential change must still take effect on the next call, as it did before.
// HOME is a temp dir so config.json and auth.json are never the operator's.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "registry-cache-"));
process.env.HOME = home;

const { getProvider, registerProvider } = await import("./registry.js");
const { CONFIG_FILE } = await import("./config.js");
const { AUTH_FILE } = await import("./auth-store.js");

const info = {
  id: "cache-fake",
  name: "cache-fake",
  defaultModel: "m",
  supportsStreaming: false,
  supportsTools: true,
  maxOutputTokens: 4096,
};

function register(): { created: () => number } {
  let n = 0;
  registerProvider("cache-fake" as never, {
    info,
    create: () => {
      n++;
      return { info, execute: async () => ({}) } as never;
    },
  });
  return { created: () => n };
}

test("the HOME redirect took: neither credential file is the operator's", () => {
  assert.ok(CONFIG_FILE.startsWith(home));
  assert.ok(AUTH_FILE.startsWith(home));
});

test("repeated lookups reuse one instance", () => {
  const counter = register();
  const first = getProvider("cache-fake" as never);
  assert.equal(getProvider("cache-fake" as never), first);
  assert.equal(getProvider("cache-fake" as never), first);
  assert.equal(counter.created(), 1);
});

test("re-registering an id drops its cached instance", () => {
  register();
  const before = getProvider("cache-fake" as never);
  const counter = register();
  const after = getProvider("cache-fake" as never);
  assert.notEqual(after, before);
  assert.equal(counter.created(), 1);
});

test("a config.json change rebuilds, so a new key applies on the next call", () => {
  const counter = register();
  const before = getProvider("cache-fake" as never);
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ providers: { "cache-fake": { apiKey: "k2" } } }));
  const after = getProvider("cache-fake" as never);
  assert.notEqual(after, before);
  assert.equal(counter.created(), 2);
  assert.equal(getProvider("cache-fake" as never), after, "and caches again");
});

test("an auth.json change rebuilds too (a subscription login decides the auth mode)", () => {
  const counter = register();
  const before = getProvider("cache-fake" as never);
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ anthropic: { type: "oauth" } }));
  assert.notEqual(getProvider("cache-fake" as never), before);
  assert.equal(counter.created(), 2);
});
