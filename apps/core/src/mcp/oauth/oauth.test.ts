// MCP OAuth (spec 2026-11-15-mcp-oauth). Everything runs against a local fake:
// an authorization server (RFC 9728 + 8414 metadata, DCR, PKCE authorize, token)
// and an MCP endpoint that answers 401 until it sees a token it issued.

import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHttpTransport } from "../transport.js";
import { createAuthFetch, McpNeedsAuthError } from "./auth-fetch.js";
import { loginMcpServer } from "./login.js";
import { isNeedsAuthError } from "./needs-auth.js";
import {
  hasMcpLogin,
  readMcpAuth,
  refreshLockPath,
  storeKey,
  updateMcpAuth,
  withRefreshLock,
} from "./store.js";

import * as fs from "fs";
import { browser, type Fake, remote, startFake, tmpFile } from "./fake-oauth-server.test.js";

async function signIn(fake: Fake, file: string): Promise<void> {
  await loginMcpServer({
    server: remote(fake),
    file,
    onAuthorizationUrl: browser,
    waitForCode: (callback, state) => callback!.waitForCode(state, 5000),
  });
}

async function connect(fake: Fake, file: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  const fetchFn = hasMcpLogin("fake", fake.mcpUrl, file)
    ? createAuthFetch({ name: "fake", url: fake.mcpUrl, file })
    : undefined;
  await client.connect(createHttpTransport({ url: fake.mcpUrl, fetch: fetchFn }));
  return client;
}

// --- store -------------------------------------------------------------------

test("store keys by name and URL, so one URL can hold two accounts", () => {
  const file = tmpFile();
  updateMcpAuth("a", "https://x.test/mcp", () => ({ tokens: { access_token: "A", token_type: "Bearer" } }), file);
  updateMcpAuth("b", "https://x.test/mcp", () => ({ tokens: { access_token: "B", token_type: "Bearer" } }), file);
  assert.equal(readMcpAuth("a", "https://x.test/mcp", file)?.tokens?.access_token, "A");
  assert.equal(readMcpAuth("b", "https://x.test/mcp", file)?.tokens?.access_token, "B");
  // A changed URL is a different entry: the old token is never sent to the new host.
  assert.equal(readMcpAuth("a", "https://y.test/mcp", file), undefined);
});

test("store file is 0600 and a corrupt file reads as empty", () => {
  const file = tmpFile();
  updateMcpAuth("a", "https://x.test/mcp", () => ({}), file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, "{not json");
  assert.equal(hasMcpLogin("a", "https://x.test/mcp", file), false);
});

test("refresh lock is exclusive and a stale one is taken over", async () => {
  const file = tmpFile();
  const key = storeKey("a", "https://x.test/mcp");
  const order: string[] = [];
  let release!: () => void;
  const first = withRefreshLock(key, () => new Promise<void>((r) => {
    order.push("first-in");
    release = () => {
      order.push("first-out");
      r();
    };
  }), file);
  await new Promise((r) => setTimeout(r, 20));
  const second = withRefreshLock(key, async () => {
    order.push("second-in");
  }, file);
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(order, ["first-in"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-in", "first-out", "second-in"]);

  // A holder that was killed leaves its file behind; an old one is taken over.
  const lock = refreshLockPath(key, file);
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  assert.equal(await withRefreshLock(key, async () => "ran", file), "ran");
});

// --- end to end --------------------------------------------------------------

test("a server that needs auth fails as needs-auth, and registers nothing", async () => {
  const fake = await startFake();
  try {
    await assert.rejects(connect(fake, tmpFile()), (err) => isNeedsAuthError(err));
    assert.equal(fake.registrations, 0);
  } finally {
    await fake.close();
  }
});

test("login registers once, stores tokens, and the next connect lists tools", async () => {
  const fake = await startFake();
  const file = tmpFile();
  try {
    await signIn(fake, file);
    const entry = readMcpAuth("fake", fake.mcpUrl, file)!;
    assert.equal(fake.registrations, 1);
    assert.equal(entry.tokens?.access_token, "a1");
    assert.equal(entry.codeVerifier, undefined, "the PKCE verifier does not outlive the sign-in");
    assert.ok(entry.expiresAt! > Date.now());

    const client = await connect(fake, file);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["ping"]);
    await client.close();

    // A second login reuses the registered client when its port is free.
    await signIn(fake, file);
    assert.equal(fake.registrations, 1);
  } finally {
    await fake.close();
  }
});

test("a rejected token is refreshed once and the rotated tokens are saved", async () => {
  const fake = await startFake();
  const file = tmpFile();
  try {
    await signIn(fake, file);
    fake.valid.clear(); // the server forgot a1, e.g. it expired early
    const client = await connect(fake, file);
    await client.listTools();
    await client.close();
    const entry = readMcpAuth("fake", fake.mcpUrl, file)!;
    assert.equal(fake.refreshes, 1);
    assert.equal(entry.tokens?.access_token, "a2");
    assert.equal(entry.tokens?.refresh_token, "r2");
  } finally {
    await fake.close();
  }
});

test("a token near expiry is refreshed before it is sent", async () => {
  const fake = await startFake();
  const file = tmpFile();
  try {
    await signIn(fake, file);
    updateMcpAuth("fake", fake.mcpUrl, (e) => ({ ...e, expiresAt: Date.now() + 5_000 }), file);
    const authFetch = createAuthFetch({ name: "fake", url: fake.mcpUrl, file });
    await authFetch(fake.mcpUrl, { method: "GET" }).then((r) => r.body?.cancel());
    assert.equal(fake.refreshes, 1);
    assert.equal(readMcpAuth("fake", fake.mcpUrl, file)?.tokens?.access_token, "a2");
  } finally {
    await fake.close();
  }
});

test("concurrent 401s in one process share a single refresh", async () => {
  const fake = await startFake();
  const file = tmpFile();
  try {
    await signIn(fake, file);
    fake.valid.clear();
    const authFetch = createAuthFetch({ name: "fake", url: fake.mcpUrl, file });
    const responses = await Promise.all(
      [1, 2, 3].map(() => authFetch(fake.mcpUrl, { method: "GET" })),
    );
    for (const r of responses) await r.body?.cancel();
    // Rotation makes a second refresh with r1 fail, so one refresh is the only passing outcome.
    assert.equal(fake.refreshes, 1);
  } finally {
    await fake.close();
  }
});

test("a token another process already refreshed is reused, not refreshed again", async () => {
  const fake = await startFake();
  const file = tmpFile();
  try {
    await signIn(fake, file);
    fake.valid.clear();
    const theirs = createAuthFetch({ name: "fake", url: fake.mcpUrl, file });
    // `mine` sends a1; while that request is in flight the other process
    // refreshes to a2. Mine's 401 must then pick up a2, not spend r2.
    let raced = false;
    const mine = createAuthFetch({
      name: "fake",
      url: fake.mcpUrl,
      file,
      fetchFn: async (input, init) => {
        const sent = new Headers(init?.headers).get("authorization");
        if (sent === "Bearer a1" && !raced) {
          raced = true;
          await (await theirs(fake.mcpUrl, { method: "GET" })).body?.cancel();
        }
        return fetch(input, init);
      },
    });
    const res = await mine(fake.mcpUrl, { method: "GET" });
    await res.body?.cancel();
    assert.ok(raced, "mine sent the stale token");
    assert.notEqual(res.status, 401);
    assert.equal(fake.refreshes, 1);
    assert.equal(readMcpAuth("fake", fake.mcpUrl, file)?.tokens?.refresh_token, "r2");
  } finally {
    await fake.close();
  }
});

test("a revoked grant clears the tokens and reports needs-auth", async () => {
  const fake = await startFake();
  const file = tmpFile();
  try {
    await signIn(fake, file);
    fake.valid.clear();
    fake.revoke();
    await assert.rejects(connect(fake, file), (err) => isNeedsAuthError(err));
    assert.equal(hasMcpLogin("fake", fake.mcpUrl, file), false);
    // The client registration survives: the next login reuses it.
    assert.ok(readMcpAuth("fake", fake.mcpUrl, file)?.client);
  } finally {
    await fake.close();
  }
});

test("insufficient_scope asks for a new login instead of retrying", async () => {
  const file = tmpFile();
  updateMcpAuth("s", "https://x.test/mcp", () => ({ tokens: { access_token: "t", token_type: "Bearer" } }), file);
  const authFetch = createAuthFetch({
    name: "s",
    url: "https://x.test/mcp",
    file,
    fetchFn: async () =>
      new Response(null, {
        status: 403,
        headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="more"' },
      }),
  });
  await assert.rejects(authFetch("https://x.test/mcp"), McpNeedsAuthError);
});

test("login refuses stdio servers and servers with a configured Authorization header", async () => {
  const noop = { onAuthorizationUrl: () => undefined, waitForCode: async () => "" };
  await assert.rejects(
    loginMcpServer({ ...noop, server: { name: "l", type: "local", command: ["x"], enabled: true, timeout: 5000 } }),
    /not a remote server/,
  );
  await assert.rejects(
    loginMcpServer({
      ...noop,
      server: { name: "h", type: "remote", url: "https://x.test/mcp", headers: { Authorization: "Bearer k" }, enabled: true, timeout: 5000 },
    }),
    /already sends an Authorization header/,
  );
});
