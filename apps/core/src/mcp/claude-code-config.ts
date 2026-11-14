// Claude Code MCP server discovery.
//
// Claude Code keeps its servers in three places, all keyed by name:
//   user:    ~/.claude.json            → mcpServers
//   project: ~/.claude.json            → projects[<cwd>].mcpServers
//   repo:    <cwd>/.mcp.json           → mcpServers
// Servers found here are merged into FreeCode's own list (see config.ts) so
// anything already set up for Claude Code works without a `freecode mcp add`.
// Read-only: FreeCode never writes back to these files.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { McpServer } from "./types.js";

/** One entry of a Claude Code `mcpServers` map. */
interface ClaudeCodeServer {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Claude Code's pre-registered OAuth client; its secret lives in their keychain, not here. */
  oauth?: { clientId?: string; callbackPort?: number };
}

interface ClaudeJson {
  mcpServers?: Record<string, ClaudeCodeServer>;
  projects?: Record<
    string,
    {
      mcpServers?: Record<string, ClaudeCodeServer>;
      disabledMcpjsonServers?: string[];
    }
  >;
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Claude Code expands `${VAR}` and `${VAR:-default}` in command, args, env,
 * url and headers. FreeCode passes env through verbatim, so expand here.
 */
export function expandEnvVars(value: string, env = process.env): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_, name: string, fallback: string | undefined) =>
      env[name] ?? fallback ?? "",
  );
}

function expandRecord(
  rec: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!rec) return undefined;
  return Object.fromEntries(
    Object.entries(rec).map(([k, v]) => [k, expandEnvVars(v)]),
  );
}

/** Translate one Claude Code entry into FreeCode's `McpServer` shape. */
export function toMcpServer(
  name: string,
  cc: ClaudeCodeServer,
): McpServer | null {
  const isRemote = cc.type === "http" || cc.type === "sse" || (!cc.command && cc.url);
  if (isRemote) {
    if (!cc.url) return null;
    return {
      name,
      type: "remote",
      url: expandEnvVars(cc.url),
      headers: expandRecord(cc.headers),
      ...(cc.oauth?.clientId || cc.oauth?.callbackPort
        ? { oauth: { clientId: cc.oauth.clientId, callbackPort: cc.oauth.callbackPort } }
        : {}),
      enabled: true,
      timeout: 5000,
      source: "claude-code",
    };
  }
  if (!cc.command) return null;
  return {
    name,
    type: "local",
    command: [expandEnvVars(cc.command)],
    args: (cc.args ?? []).map((a) => expandEnvVars(a)),
    env: expandRecord(cc.env),
    enabled: true,
    timeout: 5000,
    source: "claude-code",
  };
}

/**
 * Every MCP server Claude Code would start for `projectPath`, in precedence
 * order (repo `.mcp.json` > project > user). A name that appears twice keeps
 * its highest-precedence definition, matching Claude Code.
 */
export function loadClaudeCodeMcpServers(
  projectPath: string,
  home = os.homedir(),
): McpServer[] {
  const claudeJson = readJson<ClaudeJson>(path.join(home, ".claude.json"));
  const project = claudeJson?.projects?.[projectPath];
  const disabledMcpjson = new Set(project?.disabledMcpjsonServers ?? []);

  const mcpJson = readJson<{ mcpServers?: Record<string, ClaudeCodeServer> }>(
    path.join(projectPath, ".mcp.json"),
  );

  const layers: Array<Record<string, ClaudeCodeServer> | undefined> = [
    Object.fromEntries(
      Object.entries(mcpJson?.mcpServers ?? {}).filter(
        ([name]) => !disabledMcpjson.has(name),
      ),
    ),
    project?.mcpServers,
    claudeJson?.mcpServers,
  ];

  const seen = new Set<string>();
  const servers: McpServer[] = [];
  for (const layer of layers) {
    for (const [name, cc] of Object.entries(layer ?? {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      const server = toMcpServer(name, cc);
      if (server) servers.push(server);
    }
  }
  return servers;
}
