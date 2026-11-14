import type { CommandModule } from "yargs";
import { loadMcpConfig } from "../../../mcp/config.js";
import { getConfigDir } from "../../utils/config.js";
import { describeMcpLogin } from "../../../mcp/oauth/store.js";

const handler = async () => {
  const config = await loadMcpConfig(getConfigDir());

  console.log("\nMCP Servers:");
  console.log("┌────────────────┬─────────┬───────────────┬────────────────────┐");
  console.log("│ Name           │ Type    │ Status        │ Tools              │");
  console.log("├────────────────┼─────────┼───────────────┼────────────────────┤");

  if (config.servers.length === 0) {
    console.log("│ (no servers configured)                                         │");
  }

  for (const server of config.servers) {
    const name = server.name.padEnd(14);
    const type = server.type.padEnd(7);
    const status = server.source === "claude-code"
      ? "claude"
      : server.enabled ? "enabled" : "disabled";
    const login =
      server.type === "remote" && server.url ? describeMcpLogin(server.name, server.url) : "—";
    const statusStr = (login === "—" ? status : `${status}, ${login === "signed in" ? "auth" : "expired"}`).padEnd(13);

    // Show command/url instead of tools (tools only available when daemon running)
    let detail = "-";
    if (server.type === "local" && server.command) {
      detail = server.command.join(" ").substring(0, 18);
    } else if (server.type === "remote" && server.url) {
      detail = server.url.replace("https://", "").substring(0, 18);
    }
    if (detail.length > 18) detail = detail.substring(0, 15) + "...";

    console.log(
      `│ ${name} │ ${type} │ ${statusStr} │ ${detail.padEnd(18)} │`,
    );
  }
  console.log(
    "└────────────────┴─────────┴───────────────┴────────────────────┘\n",
  );
  console.log(
    "Note: Status shows config-only. Run 'freecode serve' (TUI/VSCode) to connect servers.\n" +
      "      'claude' = imported from Claude Code (~/.claude.json, .mcp.json); FREECODE_MCP_CLAUDE_CODE=0 hides them.\n" +
      "      'auth' = signed in with 'freecode mcp login <name>'.\n",
  );
};

export const listCommand: CommandModule = {
  command: "list",
  describe: "List configured MCP servers",
  handler,
};
