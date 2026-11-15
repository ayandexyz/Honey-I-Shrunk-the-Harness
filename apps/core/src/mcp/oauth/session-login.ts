// =============================================================================
// Sign-in started from inside a running FreeCode (spec 2026-11-15-mcp-oauth
// Phase 2), the path behind the `authenticate` tool.
//
// Claude Code's McpAuthTool: start the flow, hand back the authorization URL at
// once, and let the browser callback finish it in the background. There is no
// terminal to paste into, so a machine that cannot bind the loopback listener
// is told to use `freecode mcp login` instead.
// =============================================================================

import type { McpServer } from "../types.js";
import { loginMcpServer } from "./login.js";

/** Long enough to read the page and click; short enough not to hold a port forever. */
export const SESSION_LOGIN_TIMEOUT_MS = 10 * 60_000;

interface Pending {
  url: Promise<string>;
}

const pending = new Map<string, Pending>();

export interface BackgroundLoginOptions {
  server: McpServer;
  /** Runs once tokens are stored: reconnect and swap in the real tools. */
  onSignedIn: () => Promise<void>;
  onFailed: (err: unknown) => void;
  file?: string;
  timeoutMs?: number;
}

/**
 * Resolve with the authorization URL to show the user. A second call while a
 * sign-in for the same server is waiting returns the same URL instead of
 * registering another client.
 */
export function startBackgroundLogin(opts: BackgroundLoginOptions): Promise<string> {
  const { server } = opts;
  const existing = pending.get(server.name);
  if (existing) return existing.url;

  let resolveUrl!: (url: string) => void;
  let rejectUrl!: (err: unknown) => void;
  const url = new Promise<string>((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  pending.set(server.name, { url });

  void loginMcpServer({
    server,
    file: opts.file,
    requireCallback: true,
    onAuthorizationUrl: (authUrl) => resolveUrl(authUrl.href),
    waitForCode: (callback, state) =>
      callback!.waitForCode(state, opts.timeoutMs ?? SESSION_LOGIN_TIMEOUT_MS),
  })
    .then(() => opts.onSignedIn())
    .catch((err) => {
      rejectUrl(err); // no-op once the URL was handed out
      opts.onFailed(err);
    })
    .finally(() => pending.delete(server.name));

  return url;
}
