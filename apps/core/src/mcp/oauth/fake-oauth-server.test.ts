// Test-only: a local fake OAuth authorization server + MCP endpoint, shared by
// the MCP OAuth tests. Named `.test.ts` so the build excludes it; it declares
// no tests of its own.

import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import type { AddressInfo } from "net";
import { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "../types.js";

export function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-"));
  return path.join(dir, "mcp-auth.json");
}

// --- fake servers ------------------------------------------------------------

export interface Fake {
  base: string;
  mcpUrl: string;
  /** Access tokens the MCP endpoint accepts. */
  valid: Set<string>;
  registrations: number;
  refreshes: number;
  /** Makes every refresh answer invalid_grant. */
  revoke(): void;
  /** The `scope` each /authorize request asked for, in order. */
  authorizeScopes: (string | null)[];
  /** Tokens posted to the revocation endpoint (only with `{ revocation: true }`). */
  revoked: { token: string; hint: string | null }[];
  close(): Promise<void>;
}

export interface FakeOptions {
  /** Advertise an RFC 7009 revocation endpoint. */
  revocation?: boolean;
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

export async function startFake(opts: FakeOptions = {}): Promise<Fake> {
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
    authorizeScopes: [],
    revoked: [],
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
        ...(opts.revocation ? { revocation_endpoint: `${base}/revoke` } : {}),
      });
    }
    if (url.pathname === "/revoke" && opts.revocation) {
      const form = new URLSearchParams(await body(req));
      const token = form.get("token")!;
      fake.revoked.push({ token, hint: form.get("token_type_hint") });
      fake.valid.delete(token);
      refreshTokens.delete(token);
      res.writeHead(200);
      return res.end();
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
      fake.authorizeScopes.push(url.searchParams.get("scope"));
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

export function remote(fake: Fake, extra: Partial<McpServer> = {}): McpServer {
  return { name: "fake", type: "remote", url: fake.mcpUrl, enabled: true, timeout: 5000, ...extra };
}

/** Follows the authorize redirect into the loopback callback, like a browser would. */
export function browser(url: URL): void {
  void fetch(url, { redirect: "follow" }).catch(() => undefined);
}
