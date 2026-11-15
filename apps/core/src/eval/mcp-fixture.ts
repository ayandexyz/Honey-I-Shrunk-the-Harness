// =============================================================================
// Per-case MCP servers for eval trials (`EvalCase.mcpServers`).
//
// The runner otherwise boots the operator's own MCP config, so no case could
// say "the user has a server that needs a login" — which is the situation the
// `authenticate` tool exists for (spec 2026-11-15-mcp-oauth Phase 2). A
// `needs-auth` fixture is a local server that answers every MCP request with
// 401 and serves real discovery + registration endpoints, so the model sees
// exactly what a user would: one `mcp__<name>__authenticate` tool, which
// returns a genuine authorization URL. Nobody approves it; teardown cancels
// the waiting sign-in and deletes what it stored.
// =============================================================================

import * as http from "http";
import type { AddressInfo } from "net";
import type { EvalMcpServer } from "./types.js";

export interface McpFixtures {
  stop(): Promise<void>;
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

export async function startMcpFixtures(servers: EvalMcpServer[]): Promise<McpFixtures> {
  const { connectEphemeralMcpServer, forgetMcpServer } = await import("../mcp/init.js");
  const http_ = http.createServer();
  await new Promise<void>((resolve) => http_.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(http_.address() as AddressInfo).port}`;
  const urlFor = (name: string) => `${base}/${name}/mcp`;
  let registrations = 0;

  http_.on("request", (req, res) => {
    const path = new URL(req.url ?? "/", base).pathname;
    const fixture = servers.find(
      (s) => path === `/${s.name}/mcp` || path === `/.well-known/oauth-protected-resource/${s.name}/mcp`,
    );
    if (fixture && path.startsWith("/.well-known/")) {
      return json(res, 200, { resource: urlFor(fixture.name), authorization_servers: [base] });
    }
    if (fixture) {
      req.resume();
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/${fixture.name}/mcp"`,
      });
      return res.end();
    }
    if (path === "/.well-known/oauth-authorization-server") {
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
    if (path === "/register") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        registrations++;
        json(res, 201, { ...JSON.parse(body || "{}"), client_id: `eval-client-${registrations}` });
      });
      return;
    }
    if (path === "/authorize") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<h1>Eval fixture</h1><p>Nobody approves sign-ins here.</p>");
    }
    res.writeHead(404);
    res.end();
  });

  for (const server of servers) {
    await connectEphemeralMcpServer({
      name: server.name,
      type: "remote",
      url: urlFor(server.name),
      enabled: true,
      timeout: 5000,
    });
  }

  return {
    async stop() {
      for (const server of servers) await forgetMcpServer(server.name, urlFor(server.name));
      // Keep-alive sockets from the SDK's fetches would hold close() open.
      http_.closeAllConnections();
      await new Promise<void>((resolve) => http_.close(() => resolve()));
    },
  };
}
