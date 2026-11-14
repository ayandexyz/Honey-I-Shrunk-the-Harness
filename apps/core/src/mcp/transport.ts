import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { logger } from "../utils/logger.js";

export interface StdioTransportConfig {
  /** Server name; picks the stderr log file. */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Where a stdio MCP server's stderr lands: `~/.freecode/logs/mcp/<name>.log`. */
export function mcpStderrLogPath(name: string, home = os.homedir()): string {
  return path.join(home, ".freecode", "logs", "mcp", `${name.replace(/[^\w.-]/g, "_")}.log`);
}

/**
 * Route the child's stderr to its log file instead of inheriting core's,
 * which the TUI renders as chatter (an MCP server's own startup banner was
 * showing up in the transcript). `FREECODE_DEBUG=1` also echoes it.
 */
function captureStderr(name: string, transport: StdioClientTransport): void {
  const stream = transport.stderr;
  if (!stream) return;
  const file = mcpStderrLogPath(name);
  let out: fs.WriteStream | undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    out = fs.createWriteStream(file, { flags: "a" });
    out.on("error", () => undefined);
  } catch {
    // unwritable home: still swallow rather than inherit.
  }
  stream.on("data", (chunk: Buffer) => {
    out?.write(chunk);
    logger.debug(`[mcp:${name}] ${chunk.toString().trimEnd()}`);
  });
}

export interface HttpTransportConfig {
  url: string;
  headers?: Record<string, string>;
  /** Sends a signed-in server's token (`oauth/auth-fetch.ts`). */
  fetch?: FetchLike;
}

export function createStdioTransport(
  config: StdioTransportConfig,
): StdioClientTransport {
  // Merge command and args: command[0] + args + server.args
  const allArgs = [
    ...(config.args || []),
  ];

  const transport = new StdioClientTransport({
    command: config.command,
    args: allArgs,
    env: config.env,
    stderr: "pipe",
  });
  captureStderr(config.name, transport);
  return transport;
}

export function createHttpTransport(
  config: HttpTransportConfig,
): StreamableHTTPClientTransport {
  // Note: timeout is not directly supported by StreamableHTTPClientTransport
  // The underlying fetch request timeout should be handled by the transport internally
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: config.headers
      ? { headers: config.headers }
      : undefined,
    fetch: config.fetch,
  });
}
