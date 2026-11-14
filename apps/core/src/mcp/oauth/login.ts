// =============================================================================
// Explicit sign-in to a remote MCP server (spec 2026-11-15-mcp-oauth §4.2).
//
// The only place a browser flow starts. Discovery (RFC 9728 → RFC 8414),
// dynamic client registration (RFC 7591), PKCE S256 and the RFC 8707 resource
// indicator are all the SDK's `auth()`; this file supplies the state it reads
// and writes (`McpAuthEntry`) and the loopback callback.
// =============================================================================

import { randomBytes } from "crypto";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  startCallbackServer,
  type CallbackServer,
} from "../../providers/anthropic-oauth-login.js";
import type { McpServer } from "../types.js";
import { expandEnvVars } from "../claude-code-config.js";
import { expiresAtFor, timedFetch } from "./auth-fetch.js";
import { MCP_AUTH_FILE, readMcpAuth, updateMcpAuth } from "./store.js";

export const CALLBACK_PATH = "/callback";
/** Redirect port when no listener could be bound: the browser fails to load it, and the user pastes the URL. */
const UNBOUND_PORT = 3118;

export interface McpLoginOptions {
  server: McpServer;
  /** Show (and usually open) the authorize URL. */
  onAuthorizationUrl: (url: URL) => void;
  /**
   * Resolve the authorization code: from the loopback `callback` (when one is
   * bound) or from a pasted redirect URL. The CLI races the two.
   */
  waitForCode: (callback: CallbackServer | undefined, state: string) => Promise<string>;
  file?: string;
  fetchFn?: FetchLike;
  now?: () => number;
}

export interface McpLoginResult {
  scope?: string;
  expiresAt?: number;
}

/** A pre-registered client from config (`oauth.clientId`), never stored in `mcp-auth.json`. */
export function staticClientFor(server: McpServer): OAuthClientInformationMixed | undefined {
  if (!server.oauth?.clientId) return undefined;
  return {
    client_id: server.oauth.clientId,
    // `${VAR}` so a secret never has to be written into config.json.
    client_secret: server.oauth.clientSecret
      ? expandEnvVars(server.oauth.clientSecret)
      : undefined,
  };
}

function registeredRedirect(client: OAuthClientInformationMixed | undefined): string | undefined {
  return client && "redirect_uris" in client ? client.redirect_uris[0] : undefined;
}

/** The port a registered client's redirect URI names: a registered client cannot use another. */
function preferredPort(server: McpServer, client: OAuthClientInformationMixed | undefined): number | undefined {
  if (server.oauth?.callbackPort) return server.oauth.callbackPort;
  const registered = registeredRedirect(client);
  return registered ? Number(new URL(registered).port) || undefined : undefined;
}

export async function loginMcpServer(opts: McpLoginOptions): Promise<McpLoginResult> {
  const { server } = opts;
  if (server.type !== "remote" || !server.url) {
    throw new Error(`"${server.name}" is not a remote server; only remote MCP servers sign in.`);
  }
  if (Object.keys(server.headers ?? {}).some((h) => h.toLowerCase() === "authorization")) {
    throw new Error(`"${server.name}" already sends an Authorization header from its config.`);
  }
  const name = server.name;
  const url = server.url;
  const file = opts.file ?? MCP_AUTH_FILE;
  const now = opts.now ?? Date.now;
  const fetchFn = timedFetch(opts.fetchFn ?? fetch);

  const stored = readMcpAuth(name, url, file);
  const port = preferredPort(server, stored?.client);
  let callback = await startCallbackServer({ port, path: CALLBACK_PATH });
  // The registered port is taken: register a new client on a free one. A
  // configured `callbackPort` is fixed on purpose and is not second-guessed.
  if (!callback && port !== undefined && !server.oauth?.callbackPort) {
    callback = await startCallbackServer({ path: CALLBACK_PATH });
  }
  const redirectUrl =
    callback?.redirectUri ?? `http://localhost:${port ?? UNBOUND_PORT}${CALLBACK_PATH}`;

  // An explicit login is a fresh grant. Keep a registered client only if it
  // can use this redirect URI; its tokens belong to it either way.
  updateMcpAuth(
    name,
    url,
    (e) => {
      const keepClient = !!e.client && registeredRedirect(e.client) === redirectUrl;
      return { discovery: e.discovery, client: keepClient ? e.client : undefined };
    },
    file,
  );

  const state = randomBytes(32).toString("base64url");
  const staticClient = staticClientFor(server);
  const entry = () => readMcpAuth(name, url, file) ?? {};
  const save = (patch: Parameters<typeof updateMcpAuth>[2]) => updateMcpAuth(name, url, patch, file);

  const clientMetadata: OAuthClientMetadata = {
    client_name: "FreeCode",
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...(server.oauth?.scope ? { scope: server.oauth.scope } : {}),
  };

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return clientMetadata;
    },
    state: () => state,
    clientInformation: () => staticClient ?? entry().client,
    saveClientInformation: (client) => save((e) => ({ ...e, client })),
    tokens: () => entry().tokens,
    saveTokens: (tokens) =>
      save((e) => ({ ...e, tokens, expiresAt: expiresAtFor(tokens, now()), codeVerifier: undefined })),
    redirectToAuthorization: (authorizationUrl) => opts.onAuthorizationUrl(authorizationUrl),
    saveCodeVerifier: (codeVerifier) => save((e) => ({ ...e, codeVerifier })),
    codeVerifier: () => {
      const verifier = entry().codeVerifier;
      if (!verifier) throw new Error("No PKCE verifier stored for this sign-in.");
      return verifier;
    },
    discoveryState: () => entry().discovery,
    saveDiscoveryState: (discovery) => save((e) => ({ ...e, discovery })),
    invalidateCredentials: (scope) =>
      save((e) => {
        if (scope === "all") return { discovery: e.discovery };
        if (scope === "client") return { ...e, client: undefined };
        if (scope === "tokens") return { ...e, tokens: undefined, expiresAt: undefined };
        if (scope === "verifier") return { ...e, codeVerifier: undefined };
        return { ...e, discovery: undefined };
      }),
  };

  try {
    const scope = server.oauth?.scope;
    const first = await auth(provider, { serverUrl: url, scope, fetchFn });
    if (first === "REDIRECT") {
      const code = await opts.waitForCode(callback, state);
      const second = await auth(provider, { serverUrl: url, scope, authorizationCode: code, fetchFn });
      if (second !== "AUTHORIZED") throw new Error("The authorization server did not issue tokens.");
    }
  } finally {
    callback?.close();
    save((e) => ({ ...e, codeVerifier: undefined }));
  }

  const done = entry();
  if (!done.tokens?.access_token) throw new Error("Sign-in finished without an access token.");
  return { scope: done.tokens.scope, expiresAt: done.expiresAt };
}
