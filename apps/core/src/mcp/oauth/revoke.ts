// =============================================================================
// Token revocation on logout (RFC 7009; spec 2026-11-15-mcp-oauth Phase 3).
//
// Claude Code's `revokeServerTokens`: refresh token first (it mints new access
// tokens, and many servers drop the access tokens with it), then the access
// token. Client auth per the server's advertised methods, and a Bearer retry
// for servers that answer 401 to RFC-compliant client auth. Best-effort — the
// caller deletes the local entry whatever happens here.
// =============================================================================

import { discoverOAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { timedFetch } from "./auth-fetch.js";
import { MCP_AUTH_FILE, readMcpAuth } from "./store.js";

export type RevokeOutcome = "revoked" | "unsupported" | "nothing-to-revoke" | "failed";

export interface RevokeOptions {
  name: string;
  url: string;
  /** A pre-registered client from config; otherwise the one stored at sign-in. */
  client?: OAuthClientInformationMixed;
  file?: string;
  fetchFn?: FetchLike;
}

export async function revokeMcpTokens(opts: RevokeOptions): Promise<RevokeOutcome> {
  const entry = readMcpAuth(opts.name, opts.url, opts.file ?? MCP_AUTH_FILE);
  const tokens = entry?.tokens;
  if (!tokens?.access_token && !tokens?.refresh_token) return "nothing-to-revoke";
  const fetchFn = timedFetch(opts.fetchFn ?? fetch);

  let metadata = entry?.discovery?.authorizationServerMetadata;
  if (!metadata) {
    try {
      metadata = (await discoverOAuthServerInfo(opts.url, { fetchFn })).authorizationServerMetadata;
    } catch {
      return "failed";
    }
  }
  // `AuthorizationServerMetadata` is a union whose OpenID variant does not
  // declare the RFC 7009 fields, so read them by name.
  const rfc7009 = metadata as
    | { revocation_endpoint?: string; revocation_endpoint_auth_methods_supported?: string[] }
    | undefined;
  const endpoint = rfc7009?.revocation_endpoint;
  if (!endpoint) return "unsupported";

  const client = opts.client ?? entry?.client;
  const methods =
    rfc7009?.revocation_endpoint_auth_methods_supported ??
    metadata?.token_endpoint_auth_methods_supported;
  const usePost =
    !!methods && !methods.includes("client_secret_basic") && methods.includes("client_secret_post");

  const revoke = async (token: string, hint: "refresh_token" | "access_token"): Promise<boolean> => {
    const params = new URLSearchParams({ token, token_type_hint: hint });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (client?.client_id && client.client_secret) {
      if (usePost) {
        params.set("client_id", client.client_id);
        params.set("client_secret", client.client_secret);
      } else {
        const basic = Buffer.from(
          `${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`,
        ).toString("base64");
        headers.authorization = `Basic ${basic}`;
      }
    } else if (client?.client_id) {
      params.set("client_id", client.client_id);
    }
    let res = await fetchFn(endpoint, { method: "POST", headers, body: params });
    // Non-compliant servers that want the access token as Bearer auth. Never
    // two auth methods at once (RFC 6749 §2.3.1), so the client creds go.
    if (res.status === 401 && tokens.access_token) {
      params.delete("client_id");
      params.delete("client_secret");
      res = await fetchFn(endpoint, {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${tokens.access_token}` },
        body: params,
      });
    }
    await res.body?.cancel();
    return res.ok;
  };

  let ok = true;
  for (const [token, hint] of [
    [tokens.refresh_token, "refresh_token"],
    [tokens.access_token, "access_token"],
  ] as const) {
    if (!token) continue;
    try {
      ok = (await revoke(token, hint)) && ok;
    } catch {
      ok = false;
    }
  }
  return ok ? "revoked" : "failed";
}
