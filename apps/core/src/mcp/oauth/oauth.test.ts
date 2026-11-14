// MCP OAuth (spec 2026-11-15-mcp-oauth). Everything runs against a local fake:
// an authorization server (RFC 9728 + 8414 metadata, DCR, PKCE authorize, token)
// and an MCP endpoint that answers 401 until it sees a token it issued.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import type { AddressInfo } from "net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHttpTransport } from "../transport.js";
import type { McpServer } from "../types.js";
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

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-"));
  return path.join(dir, "mcp-auth.json");
}

// --- fake servers ------------------------------------------------------------

interface Fake {
  base: string;
  mcpUrl: string;
  /** Access tokens the MCP endpoint accepts. */
  valid: Set<string>;
  registrations: number;
  refreshes: number;
  /** Makes every refresh answer invalid_grant. */
  revoke(): void;
  close(): Promise<void>;
}

async function body(req: http.IncomingMessage): Promise<string> {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data;
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

async function startFake(): Promise<Fake> {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const challenges = new Map<string, { challenge: string; redirect: string }>();
  const clientMethods = new Map<string, string>();
  let seq = 0;
  let revoked = false;
  const refreshTokens = new Set<string>();
  const fake: Fake = {
    base,
    mcpUrl: `${base}/mcp`,
    valid: new Set(),
    registrations: 0,
    refreshes: 0,
    revoke: () => {
      revoked = true;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
  const issue = (res: http.ServerResponse) => {
    seq++;
    const access = `a${seq}`;
    const refresh = `r${seq}`;
    fake.valid.add(access);
    refreshTokens.add(refresh);
    json(res, 200, { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: "mcp:connect" });
  };

  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(res, 200, { resource: fake.mcpUrl, authorization_servers: [base], scopes_supported: ["mcp:connect"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      // Like the MCP demo server: RFC 7591's default method is
      // client_secret_basic, so a registration that names none gets a secret
      // — which this token endpoint (advertising "none" only) then rejects.
      fake.registrations++;
      const meta = JSON.parse(await body(req)) as Record<string, unknown>;
      const clientId = `client-${fake.registrations}`;
      const method = (meta.token_endpoint_auth_method as string | undefined) ?? "client_secret_basic";
      clientMethods.set(clientId, method);
      return json(res, 201, {
        ...meta,
        client_id: clientId,
        ...(method === "none" ? {} : { client_secret: `secret-${fake.registrations}` }),
      });
    }
    if (url.pathname === "/authorize") {
      // Stands in for the user approving in a browser.
      const code = `code-${challenges.size + 1}`;
      const redirect = url.searchParams.get("redirect_uri")!;
      challenges.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect });
      const back = new URL(redirect);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === "/token") {
      const form = new URLSearchParams(await body(req));
      const basic = req.headers.authorization?.startsWith("Basic ")
        ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":")[0]
        : undefined;
      const clientId = form.get("client_id") ?? basic;
      if (!clientId || clientMethods.get(clientId) !== "none") {
        return json(res, 401, { error: "invalid_client" });
      }
      if (form.get("grant_type") === "authorization_code") {
        const pending = challenges.get(form.get("code")!);
        const verifier = form.get("code_verifier") ?? "";
        const ok =
          pending &&
          createHash("sha256").update(verifier).digest("base64url") === pending.challenge &&
          form.get("redirect_uri") === pending.redirect;
        if (!ok) return json(res, 400, { error: "invalid_grant" });
        return issue(res);
      }
      if (form.get("grant_type") === "refresh_token") {
        fake.refreshes++;
        const token = form.get("refresh_token")!;
        if (revoked || !refreshTokens.has(token)) return json(res, 400, { error: "invalid_grant" });
        refreshTokens.delete(token); // rotation: a refresh token works once
        return issue(res);
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/mcp") {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!fake.valid.has(token)) {
        res.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
        });
        return res.end();
      }
      const mcp = new SdkMcpServer({ name: "fake", version: "1.0.0" });
      mcp.registerTool("ping", { description: "Replies pong" }, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      const raw = req.method === "POST" ? await body(req) : "";
      return transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    }
    res.writeHead(404);
    res.end();
  });
  return fake;
}

function remote(fake: Fake, extra: Partial<McpServer> = {}): McpServer {
  return { name: "fake", type: "remote", url: fake.mcpUrl, enabled: true, timeout: 5000, ...extra };
}

/** Follows the authorize redirect into the loopback callback, like a browser would. */
function browser(url: URL): void {
  void fetch(url, { redirect: "follow" }).catch(() => undefined);
}

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
