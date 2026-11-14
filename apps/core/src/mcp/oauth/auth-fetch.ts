// =============================================================================
// Authenticated fetch for a signed-in remote MCP server (spec
// 2026-11-15-mcp-oauth §4.1, §4.4).
//
// Why a fetch wrapper and not the SDK's `authProvider` transport option: on a
// 401 the SDK runs its whole `auth()` orchestrator, which for a server with no
// stored client performs dynamic client registration and then calls
// `redirectToAuthorization` — i.e. a background connect would register a new
// OAuth client at the server on every daemon start. Its refresh also cannot be
// held under our cross-process lock. pi makes the same split: connections only
// send the stored token and refresh it; a browser flow happens on an explicit
// sign-in (`login.ts`) and nowhere else.
// =============================================================================

import {
  discoverOAuthServerInfo,
  refreshAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  MCP_AUTH_FILE,
  readMcpAuth,
  storeKey,
  updateMcpAuth,
  withRefreshLock,
} from "./store.js";

/** Access tokens this close to expiry are refreshed before they are sent. */
const REFRESH_SKEW_MS = 30_000;
/** Each request to the authorization server; an unresponsive one must not hold the lock. */
export const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/** The server needs `freecode mcp login <name>`; never a transient failure. */
export class McpNeedsAuthError extends Error {
  constructor(
    readonly server: string,
    readonly reason: string,
  ) {
    super(`MCP server "${server}" needs a login (${reason}). Run: freecode mcp login ${server}`);
    this.name = "McpNeedsAuthError";
  }
}

export function timedFetch(base: FetchLike = fetch): FetchLike {
  return (url, init) => {
    const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
    return base(url, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };
}

/** `expires_in` is seconds from now; absent means the server did not say. */
export function expiresAtFor(tokens: OAuthTokens, now: number): number | undefined {
  return tokens.expires_in !== undefined ? now + tokens.expires_in * 1000 : undefined;
}

export interface AuthFetchOptions {
  name: string;
  url: string;
  /** A pre-registered client from config; otherwise the one stored at sign-in. */
  client?: OAuthClientInformationMixed;
  file?: string;
  /** The network; tests pass a fake. */
  fetchFn?: FetchLike;
  now?: () => number;
}

export function createAuthFetch(opts: AuthFetchOptions): FetchLike {
  const { name, url } = opts;
  const file = opts.file ?? MCP_AUTH_FILE;
  const base = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  let refreshing: Promise<void> | undefined;

  /** Replace `stale`, the access token that expired or was rejected. One at a time per process. */
  const refresh = (stale: string): Promise<void> => {
    refreshing ??= withRefreshLock(
      storeKey(name, url),
      async () => {
        const entry = readMcpAuth(name, url, file);
        // Another process (or a login) already replaced it: use theirs.
        if (entry?.tokens?.access_token !== stale) return;
        const refreshToken = entry.tokens.refresh_token;
        const client = opts.client ?? entry.client;
        if (!refreshToken || !client) {
          throw new McpNeedsAuthError(name, "the login expired");
        }
        const discovery =
          entry.discovery ?? (await discoverOAuthServerInfo(url, { fetchFn: timedFetch(base) }));
        const resource = discovery.resourceMetadata?.resource;
        let fresh: OAuthTokens;
        try {
          fresh = await refreshAuthorization(discovery.authorizationServerUrl, {
            metadata: discovery.authorizationServerMetadata,
            clientInformation: client,
            refreshToken,
            resource: resource ? new URL(resource) : undefined,
            fetchFn: timedFetch(base),
          });
        } catch (err) {
          // invalid_grant & co: the grant is dead, a new login is the only fix.
          // A ServerError or a network failure is transient — surface it as is.
          if (err instanceof OAuthError && !(err instanceof ServerError)) {
            updateMcpAuth(name, url, (e) => ({ ...e, tokens: undefined, expiresAt: undefined }), file);
            throw new McpNeedsAuthError(name, "the login was revoked or expired");
          }
          throw err;
        }
        // Saved even if the caller has given up: the old refresh token may
        // already be dead. A response without a refresh token keeps the old one.
        updateMcpAuth(
          name,
          url,
          (e) => ({
            ...e,
            discovery,
            tokens: { ...fresh, refresh_token: fresh.refresh_token ?? refreshToken },
            expiresAt: expiresAtFor(fresh, now()),
          }),
          file,
        );
      },
      file,
    ).finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  const currentToken = async (): Promise<string> => {
    await refreshing?.catch(() => undefined);
    const entry = readMcpAuth(name, url, file);
    const token = entry?.tokens?.access_token;
    if (!token) throw new McpNeedsAuthError(name, "not signed in");
    const expiring =
      entry.expiresAt !== undefined && entry.expiresAt - REFRESH_SKEW_MS <= now();
    if (!expiring || !entry.tokens?.refresh_token) return token;
    // A failed pre-emptive refresh falls through: the old token goes out and
    // the server's 401 decides.
    await refresh(token).catch(() => undefined);
    return readMcpAuth(name, url, file)?.tokens?.access_token ?? token;
  };

  const send = (input: string | URL, init: RequestInit | undefined, token: string) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return base(input, { ...init, headers });
  };

  return async (input, init) => {
    const token = await currentToken();
    const res = await send(input, init, token);
    if (res.status === 403 && /insufficient_scope/.test(res.headers.get("www-authenticate") ?? "")) {
      await res.body?.cancel();
      throw new McpNeedsAuthError(name, "the server asks for more permissions");
    }
    if (res.status !== 401) return res;
    await res.body?.cancel();
    await refresh(token);
    const retried = readMcpAuth(name, url, file)?.tokens?.access_token;
    if (!retried) throw new McpNeedsAuthError(name, "the login expired");
    const again = await send(input, init, retried);
    if (again.status === 401) {
      await again.body?.cancel();
      throw new McpNeedsAuthError(name, "the server rejected the refreshed token");
    }
    return again;
  };
}
