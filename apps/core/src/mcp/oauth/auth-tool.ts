// =============================================================================
// `mcp__<server>__authenticate` — the one tool a server that needs a login
// offers in place of its real ones (spec 2026-11-15-mcp-oauth Phase 2;
// Claude Code's McpAuthTool). Without it the model cannot know the server
// exists, and a user asking for it gets "I have no such tool".
//
// Calling it starts a sign-in and returns the URL for the user. When the
// browser callback lands, `onSignedIn` reconnects the server; its real tools
// share the `mcp__<server>__` prefix, so the reconnect replaces this one.
// =============================================================================

import type { Tool } from "../../tools/tool.types.js";
import type { McpServer } from "../types.js";
import { startBackgroundLogin } from "./session-login.js";

export function authToolId(server: string): string {
  return `mcp__${server}__authenticate`;
}

export interface AuthToolOptions {
  server: McpServer;
  onSignedIn: () => Promise<void>;
  onFailed: (err: unknown) => void;
}

export function createMcpAuthTool(opts: AuthToolOptions): Tool {
  const { server } = opts;
  const id = authToolId(server.name);
  return {
    id,
    description:
      `The \`${server.name}\` MCP server (${server.url}) is configured but requires a login. ` +
      "Call this tool to start the sign-in — you'll receive an authorization URL to share with the user. " +
      "Once the user completes it in their browser, the server's real tools become available automatically.",
    schemas: { parameters: { type: "object", properties: {} } },
    behavior: {
      isConcurrencySafe: false,
      // Single-attempt: a retry would start a second sign-in.
      isDestructive: true,
      userFacingName: `${server.name}/authenticate`,
    },
    permissions: { operations: ["mcp"] },
    execute: async (_params, ctx) => {
      if (ctx.unattended) {
        return {
          success: false,
          error: `MCP server "${server.name}" needs a login and nobody is here to complete it. Continue without it; the user can run \`freecode mcp login ${server.name}\` later.`,
        };
      }
      try {
        const url = await startBackgroundLogin(opts);
        return {
          success: true,
          result: {
            title: id,
            output:
              `Ask the user to open this URL in their browser to sign in to the ${server.name} MCP server:\n\n${url}\n\n` +
              "Once they finish, the server's tools become available automatically (within 10 minutes; after that, call this tool again).",
          },
        };
      } catch (err) {
        return {
          success: false,
          error: `Could not start the sign-in for ${server.name}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
