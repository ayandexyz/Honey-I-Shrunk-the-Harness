// Which servers failed to connect because they need a login (spec
// 2026-11-15-mcp-oauth §4.1), and the notices about them that a frontend has
// not seen yet. In-process only: the daemon connects once at start, so a cache
// across processes would save one failed `initialize`.
//
// MCP connects before any session exists to carry a notice, so notices queue
// here and `session.send` drains them.

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpNeedsAuthError } from "./auth-fetch.js";

const needsAuth = new Map<string, { url: string; reason: string }>();
const notices: string[] = [];

/** A connect error that a login fixes, as opposed to a down or broken server. */
export function isNeedsAuthError(err: unknown): boolean {
  return (
    err instanceof McpNeedsAuthError ||
    err instanceof UnauthorizedError ||
    (err instanceof StreamableHTTPError && err.code === 401)
  );
}

export function markNeedsAuth(server: string, url: string, reason: string): void {
  if (!needsAuth.has(server)) {
    notices.push(`MCP server "${server}" needs a login (${reason}) — run: freecode mcp login ${server}`);
  }
  needsAuth.set(server, { url, reason });
}

export function clearNeedsAuth(server: string): void {
  needsAuth.delete(server);
}

/** Servers waiting on a login, with the URL their stored sign-in is keyed by. */
export function needsAuthServers(): Array<{ name: string; url: string }> {
  return [...needsAuth].map(([name, { url }]) => ({ name, url }));
}

export function noteMcpAuth(line: string): void {
  notices.push(line);
}

/** Notices a frontend has not seen yet, each delivered once. */
export function takeMcpAuthNotices(): string[] {
  return notices.splice(0);
}

/** Tests only. */
export function resetNeedsAuth(): void {
  needsAuth.clear();
  notices.length = 0;
}
