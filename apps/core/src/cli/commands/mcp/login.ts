// `freecode mcp login|logout <name>` (spec 2026-11-15-mcp-oauth §4.2, §4.5).
// Presentation only: the protocol lives in `mcp/oauth/`.

import type { CommandModule } from "yargs";
import { loadMcpConfig } from "../../../mcp/config.js";
import { loginMcpServer, staticClientFor } from "../../../mcp/oauth/login.js";
import { revokeMcpTokens } from "../../../mcp/oauth/revoke.js";
import { deleteMcpAuth, readMcpAuth } from "../../../mcp/oauth/store.js";
import { parseAuthCodeInput } from "../../../providers/anthropic-oauth-login.js";
import { getConfigDir } from "../../utils/config.js";
import { openBrowser, prompt } from "../auth.js";

const CALLBACK_TIMEOUT_MS = 120_000;

interface LoginArgs {
  name: string;
  browser: boolean;
}

async function findServer(name: string) {
  const config = await loadMcpConfig(getConfigDir());
  const server = config.servers.find((s) => s.name === name);
  if (!server) {
    console.error(`Error: MCP server "${name}" not found in config`);
    process.exit(1);
  }
  return server;
}

/** A pasted redirect URL or bare code; a `state` that is present must be this sign-in's. */
async function pastedCode(state: string): Promise<string> {
  const input = (await prompt("Paste the redirect URL from the browser address bar: ")).trim();
  if (!input) throw new Error("No redirect URL entered.");
  const parsed = parseAuthCodeInput(input);
  if (parsed.state && parsed.state !== state) {
    throw new Error("That redirect URL belongs to a different sign-in. Start the login again.");
  }
  return parsed.code;
}

export const loginCommand: CommandModule<object, LoginArgs> = {
  command: "login <name>",
  describe: "Sign in to a remote MCP server (OAuth)",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("browser", {
        type: "boolean",
        default: true,
        describe: "open the authorize URL in a browser (--no-browser to skip)",
      }) as never,
  handler: async (argv) => {
    const server = await findServer(argv.name);
    try {
      const result = await loginMcpServer({
        server,
        onAuthorizationUrl: (url) => {
          console.error(`Open this URL to sign in to "${server.name}":\n\n  ${url.href}\n`);
          if (argv.browser) openBrowser(url.href);
        },
        waitForCode: async (callback, state) => {
          if (callback && argv.browser) {
            console.error(`Waiting up to ${CALLBACK_TIMEOUT_MS / 1000}s for the browser ...`);
            try {
              return await callback.waitForCode(state, CALLBACK_TIMEOUT_MS);
            } catch (e) {
              console.error(`${e instanceof Error ? e.message : String(e)} Falling back to pasting.\n`);
            }
          } else {
            console.error(
              "Finish in a browser (this or another device). It will fail to load the " +
                "localhost page at the end — copy that page's URL and paste it here.\n",
            );
          }
          return pastedCode(state);
        },
      });
      const scope = result.scope ? ` (scope: ${result.scope})` : "";
      console.log(`Signed in to ${server.name}${scope}.`);
      console.log(
        "Restart FreeCode to load its tools. To check the sign-in now: " +
          `freecode mcp start ${server.name}`,
      );
    } catch (e) {
      console.error(`Sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  },
};

export const logoutCommand: CommandModule<object, { name: string }> = {
  command: "logout <name>",
  describe: "Forget a remote MCP server's sign-in",
  builder: (yargs) => yargs.positional("name", { type: "string", demandOption: true }),
  handler: async (argv) => {
    const server = await findServer(argv.name);
    if (server.type !== "remote" || !server.url || !readMcpAuth(server.name, server.url)) {
      console.log(`No sign-in stored for ${server.name}.`);
      return;
    }
    // Best-effort: the local entry goes whatever the server says.
    const outcome = await revokeMcpTokens({
      name: server.name,
      url: server.url,
      client: staticClientFor(server),
    });
    deleteMcpAuth(server.name, server.url);
    const note = {
      revoked: "tokens revoked at the server",
      unsupported: "the server offers no revocation; its tokens expire on their own",
      "nothing-to-revoke": "no tokens were stored",
      failed: "revoking at the server failed; its tokens expire on their own",
    }[outcome];
    console.log(`Signed out of ${server.name} (${note}).`);
  },
};
