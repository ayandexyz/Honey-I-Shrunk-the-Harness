// =============================================================================
// MCP OAuth state — `~/.freecode/mcp-auth.json` (spec 2026-11-15-mcp-oauth §4.3).
//
// One entry per server, keyed by name AND url (pi's `storeKeys`): two configs
// pointing at one URL keep separate accounts, and changing a server's URL never
// sends its old token to the new host. A separate file from `auth.json` because
// the shape differs (client registration, discovery, PKCE verifier per server).
// Same file rules as `providers/auth-store.ts`: 0600, re-chmod on every write.
//
// Nothing here talks to the network.
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

export const MCP_AUTH_FILE = path.join(os.homedir(), ".freecode", "mcp-auth.json");

export interface McpAuthEntry {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** ms since epoch; absent when the server sent no `expires_in`. */
  expiresAt?: number;
  discovery?: OAuthDiscoveryState;
  /** Only between the authorize redirect and the code exchange. */
  codeVerifier?: string;
}

export function storeKey(name: string, url: string): string {
  return `${name}|${String(new URL(url))}`;
}

function readAll(file: string): Record<string, McpAuthEntry> {
  if (!fs.existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, McpAuthEntry>)
      : {};
  } catch {
    // A corrupt file must not stop every server from connecting; the next
    // save rewrites it whole.
    return {};
  }
}

function writeAll(all: Record<string, McpAuthEntry>, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename so a concurrent reader never sees half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function readMcpAuth(
  name: string,
  url: string,
  file: string = MCP_AUTH_FILE,
): McpAuthEntry | undefined {
  return readAll(file)[storeKey(name, url)];
}

/** Read-modify-write one entry. Returning `undefined` from `update` deletes it. */
export function updateMcpAuth(
  name: string,
  url: string,
  update: (entry: McpAuthEntry) => McpAuthEntry | undefined,
  file: string = MCP_AUTH_FILE,
): void {
  const all = readAll(file);
  const key = storeKey(name, url);
  const next = update({ ...all[key] });
  if (next === undefined) delete all[key];
  else all[key] = next;
  writeAll(all, file);
}

export function deleteMcpAuth(
  name: string,
  url: string,
  file: string = MCP_AUTH_FILE,
): boolean {
  const all = readAll(file);
  const key = storeKey(name, url);
  if (!(key in all)) return false;
  delete all[key];
  writeAll(all, file);
  return true;
}

/** A stored sign-in exists — the only case in which a connection sends a token. */
export function hasMcpLogin(
  name: string,
  url: string,
  file: string = MCP_AUTH_FILE,
): boolean {
  return readMcpAuth(name, url, file)?.tokens?.access_token !== undefined;
}

/** For `freecode mcp list|status`: config-time only, a connect is what proves it. */
export function describeMcpLogin(
  name: string,
  url: string,
  now: number = Date.now(),
  file: string = MCP_AUTH_FILE,
): "signed in" | "expired" | "—" {
  const entry = readMcpAuth(name, url, file);
  if (!entry?.tokens?.access_token) return "—";
  const expired = entry.expiresAt !== undefined && entry.expiresAt <= now;
  return expired && !entry.tokens.refresh_token ? "expired" : "signed in";
}

// --- cross-process refresh lock ----------------------------------------------
//
// Authorization servers commonly rotate refresh tokens, so two processes
// refreshing one grant (daemon + `freecode run` + `freecode night`) log each
// other out. The lock is held from reading the tokens to saving the new ones.
// Exclusive-create, like `memory/consolidation-lock.ts`; a holder that was
// killed leaves a file that goes stale and is taken over.

/** Longer than a refresh can take: discovery + token call, each ≤ 15s. */
export const REFRESH_LOCK_STALE_MS = 60_000;
const REFRESH_LOCK_WAIT_MS = 65_000;
const REFRESH_LOCK_RETRY_MS = 100;

export function refreshLockPath(key: string, file: string = MCP_AUTH_FILE): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return path.join(path.dirname(file), `mcp-auth-refresh-${hash}.lock`);
}

export async function withRefreshLock<T>(
  key: string,
  fn: () => Promise<T>,
  file: string = MCP_AUTH_FILE,
): Promise<T> {
  const lock = refreshLockPath(key, file);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + REFRESH_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released between our open and stat
      }
      if (age > REFRESH_LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for another process's MCP token refresh.");
      }
      await new Promise((r) => setTimeout(r, REFRESH_LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
