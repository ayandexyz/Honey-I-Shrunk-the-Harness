// Which servers failed to connect because they need a login (spec
// 2026-11-15-mcp-oauth §4.1). In-process only: the daemon connects once at
// start, so a cache across processes would save one failed `initialize`.

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpNeedsAuthError } from "./auth-fetch.js";

const needsAuth = new Map<string, string>();
const announced = new Set<string>();

/** A connect error that a login fixes, as opposed to a down or broken server. */
export function isNeedsAuthError(err: unknown): boolean {
  return (
    err instanceof McpNeedsAuthError ||
    err instanceof UnauthorizedError ||
    (err instanceof StreamableHTTPError && err.code === 401)
  );
}

export function markNeedsAuth(server: string, reason: string): void {
  needsAuth.set(server, reason);
}

export function clearNeedsAuth(server: string): void {
  needsAuth.delete(server);
  announced.delete(server);
}

export function needsAuthServers(): string[] {
  return [...needsAuth.keys()];
}

/** The line a frontend shows, once per server per process. */
export function takeUnannouncedNeedsAuth(): string[] {
  const lines: string[] = [];
  for (const [server, reason] of needsAuth) {
    if (announced.has(server)) continue;
    announced.add(server);
    lines.push(`MCP server "${server}" needs a login (${reason}) — run: freecode mcp login ${server}`);
  }
  return lines;
}
