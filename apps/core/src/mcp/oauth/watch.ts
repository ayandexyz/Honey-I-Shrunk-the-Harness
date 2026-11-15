// A running FreeCode picks up `freecode mcp login` from another terminal
// (spec 2026-11-15-mcp-oauth §7 Q2) by polling `mcp-auth.json` — only while
// some server is waiting on a login, so the common case costs nothing.
// `watchFile` (stat polling) rather than `fs.watch`: the store replaces the
// file by rename, and the file may not exist yet.

import * as fs from "fs";
import { needsAuthServers } from "./needs-auth.js";
import { hasMcpLogin, MCP_AUTH_FILE } from "./store.js";

const POLL_MS = 2_000;

let watching: string | undefined;

/** Start (idempotent) watching for logins; stops itself when nobody is waiting. */
export function watchForLogins(
  reconnect: (name: string) => Promise<void>,
  file: string = MCP_AUTH_FILE,
): void {
  if (watching) return;
  watching = file;
  // Not persistent: a `freecode run` must still exit on its own.
  fs.watchFile(file, { interval: POLL_MS, persistent: false }, () => {
    void (async () => {
      for (const { name, url } of needsAuthServers()) {
        if (hasMcpLogin(name, url, file)) await reconnect(name);
      }
      if (needsAuthServers().length === 0) stopWatchingForLogins();
    })();
  });
}

export function stopWatchingForLogins(): void {
  if (!watching) return;
  fs.unwatchFile(watching);
  watching = undefined;
}
