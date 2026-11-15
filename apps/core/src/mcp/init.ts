import * as os from "os";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { loadMcpConfig } from "./config.js";
import { createStdioTransport, createHttpTransport } from "./transport.js";
import {
  registerClient,
  removeClient,
  getClient,
  listClients,
} from "./client-registry.js";
import { convertMcpTool } from "./convert-tool.js";
import { registerMcpTool, unregisterMcpTools } from "../tools/index.js";
import {
  setMcpToolReadOnly,
  clearMcpToolKinds,
} from "../permission/mode-policy.js";
import { BusEvents } from "../bus/index.js";
import type { McpServer } from "./types.js";
import { createAuthFetch, McpNeedsAuthError } from "./oauth/auth-fetch.js";
import { hasMcpLogin } from "./oauth/store.js";
import { staticClientFor } from "./oauth/login.js";
import {
  clearNeedsAuth,
  isNeedsAuthError,
  markNeedsAuth,
  needsAuthServers,
  noteMcpAuth,
} from "./oauth/needs-auth.js";
import { createMcpAuthTool } from "./oauth/auth-tool.js";
import { stopWatchingForLogins, watchForLogins } from "./oauth/watch.js";

function getConfigDir(): string {
  return path.join(os.homedir(), ".freecode");
}

async function connectServer(
  server: McpServer,
): Promise<{ name: string; toolCount: number } | null> {
  try {
    let transport;
    const timeout = server.timeout ?? 30000;
    if (server.type === "local") {
      // Combine command args (command[0] + args) with server.args
      const cmdArgs = server.command?.slice(1) || [];
      const extraArgs = server.args || [];
      transport = createStdioTransport({
        name: server.name,
        command: server.command?.[0] || "",
        args: [...cmdArgs, ...extraArgs],
        env: server.env as Record<string, string> | undefined,
      });
    } else if (server.type === "remote") {
      if (!server.url) {
        throw new Error("URL is required for remote MCP servers");
      }
      // A configured Authorization header wins; otherwise a stored sign-in
      // is sent. With neither, a server that needs auth answers 401 and is
      // reported as needing a login below — a connect never starts one.
      const configuredAuth = Object.keys(server.headers ?? {}).some(
        (h) => h.toLowerCase() === "authorization",
      );
      transport = createHttpTransport({
        url: server.url,
        headers: server.headers as Record<string, string> | undefined,
        fetch:
          !configuredAuth && hasMcpLogin(server.name, server.url)
            ? createAuthFetch({
                name: server.name,
                url: server.url,
                client: staticClientFor(server),
              })
            : undefined,
      });
    } else {
      throw new Error(`Unknown MCP server type: ${server.type}`);
    }

    const mcpClient = new Client(
      {
        name: server.name,
        version: "1.0.0",
      },
      {
        capabilities: {},
      },
    );

    await Promise.race([
      mcpClient.connect(transport),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error(`MCP server "${server.name}" connect timed out after ${timeout}ms`)),
          timeout,
        ),
      ),
    ]);

    // Register the client so tools can use it
    registerClient(server.name, mcpClient, timeout);

    // List tools and register them
    const toolsResponse = await mcpClient.listTools();
    const tools = toolsResponse.tools || [];

    for (const tool of tools) {
      const converted = convertMcpTool(tool, server.name);
      registerMcpTool(converted);
      // A server declaring a tool read-only is what lets the permission layer
      // stop prompting for it; without the claim it stays mutating.
      if (tool.annotations?.readOnlyHint === true) {
        setMcpToolReadOnly(converted.id);
      }
    }

    clearNeedsAuth(server.name);
    BusEvents.mcpServerStarted(server.name, tools.length);

    return { name: server.name, toolCount: tools.length };
  } catch (err) {
    if (isNeedsAuthError(err) && server.url) {
      markNeedsAuth(
        server.name,
        server.url,
        err instanceof McpNeedsAuthError ? err.reason : "not signed in",
      );
      offerAuthenticate(server);
    }
    BusEvents.mcpServerError(server.name, String(err));
    return null;
  }
}

/**
 * A server that needs a login offers the model one `authenticate` tool in
 * place of its real ones (spec Phase 2), and the daemon starts watching for a
 * login made from another terminal.
 */
function offerAuthenticate(server: McpServer): void {
  registerMcpTool(
    createMcpAuthTool({
      server,
      onSignedIn: () => reconnectAfterLogin(server.name),
      onFailed: (err) =>
        noteMcpAuth(
          `Sign-in to MCP server "${server.name}" did not finish: ${err instanceof Error ? err.message : String(err)}`,
        ),
    }),
  );
  BusEvents.mcpToolsChanged(server.name);
  watchForLogins(reconnectAfterLogin);
}

const reconnecting = new Set<string>();

/**
 * Connect a server that was waiting on a login, now that one is stored. Its
 * real tools replace the `authenticate` tool (same `mcp__<name>__` prefix);
 * the tool-set change is journaled for the cache-miss detector like any other.
 * Both the in-session sign-in and the file watcher land here, so it is
 * idempotent.
 */
export async function reconnectAfterLogin(name: string): Promise<void> {
  if (reconnecting.has(name) || getClient(name)) return;
  reconnecting.add(name);
  try {
    const server = (await loadMcpConfig(getConfigDir())).servers.find((s) => s.name === name);
    if (!server) return;
    unregisterMcpTools(`mcp__${name}__`);
    const result = await connectServer(server);
    BusEvents.mcpToolsChanged(name);
    if (result) {
      noteMcpAuth(`Signed in to MCP server "${name}" — ${result.toolCount} tools available.`);
    }
  } finally {
    reconnecting.delete(name);
  }
}

export async function initMcpServers(): Promise<void> {
  const configDir = getConfigDir();
  const config = await loadMcpConfig(configDir);

  const enabledServers = config.servers.filter((s) => s.enabled !== false);

  // Connect to all enabled servers in parallel
  const results = await Promise.allSettled(
    enabledServers.map((server) => connectServer(server)),
  );

  // Emit tools changed for all servers that connected successfully
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      BusEvents.mcpToolsChanged(result.value.name);
    }
  }
}

export async function stopMcpServers(): Promise<void> {
  const names = listClients();

  for (const name of names) {
    try {
      const client = getClient(name);
      if (client) {
        await client.close();
        removeClient(name);
        BusEvents.mcpServerStopped(name, "shutdown");
      }
    } catch (err) {
      // Ignore errors during shutdown
    }
  }

  // Unregister all MCP tools
  for (const name of names) {
    unregisterMcpTools(`mcp__${name}__`);
    clearMcpToolKinds(`mcp__${name}__`);
  }

  // Servers that never connected still hold their `authenticate` tool.
  stopWatchingForLogins();
  for (const { name } of needsAuthServers()) {
    unregisterMcpTools(`mcp__${name}__`);
    clearNeedsAuth(name);
  }
}

// Connect a single MCP server by name
export async function connectMcpServer(
  name: string,
): Promise<{ name: string; toolCount: number } | null> {
  const configDir = getConfigDir();
  const config = await loadMcpConfig(configDir);

  const server = config.servers.find((s) => s.name === name);
  if (!server) {
    throw new Error(`MCP server "${name}" not found in config`);
  }

  // Check if already connected
  if (getClient(name)) {
    throw new Error(`MCP server "${name}" is already connected`);
  }

  const result = await connectServer(server);
  if (result) {
    BusEvents.mcpToolsChanged(name);
  }
  return result;
}

// Disconnect a single MCP server by name
export async function disconnectMcpServer(name: string): Promise<void> {
  const client = getClient(name);
  if (!client) {
    throw new Error(`MCP server "${name}" is not connected`);
  }

  await client.close();
  removeClient(name);
  unregisterMcpTools(`mcp__${name}__`);
  clearMcpToolKinds(`mcp__${name}__`);
  BusEvents.mcpServerStopped(name, "manual");
}
