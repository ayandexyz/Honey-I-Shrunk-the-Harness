import { z } from "zod";

export const McpServerSchema = z
  .object({
    name: z.string(),
    type: z.enum(["local", "remote"]),
    // Local (stdio) config
    command: z.array(z.string()).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    // Remote (HTTP) config
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // OAuth client for a server without dynamic client registration
    // (spec 2026-11-15-mcp-oauth §4.2). `clientSecret` may be `${ENV_VAR}`.
    oauth: z
      .object({
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        scope: z.string().optional(),
        callbackPort: z.number().int().positive().optional(),
      })
      .optional(),
    // Common config
    enabled: z.boolean().default(true),
    timeout: z.number().default(5000),
    // Where the definition came from. Absent means FreeCode's own config.json;
    // "claude-code" entries are read-only mirrors (see claude-code-config.ts).
    source: z.enum(["claude-code"]).optional(),
  })
  .refine(
    (data) =>
      data.type !== "remote" || (data.url !== undefined && data.url !== ""),
    { message: "URL is required for remote MCP servers", path: ["url"] },
  );

export const McpConfigSchema = z.object({
  servers: z.array(McpServerSchema).default([]),
  pollInterval: z.number().default(5000),
});

export const ConfigSchema = z.object({
  providers: z
    .record(
      z.string(),
      z.object({
        apiKey: z.string(),
        model: z.string().optional(),
      }),
    )
    .optional(),
  current: z
    .object({
      provider: z.string(),
      model: z.string(),
    })
    .optional(),
  mcp: McpConfigSchema.optional(),
});

export type McpServer = z.infer<typeof McpServerSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export interface McpClient {
  readonly name: string;
  readonly status: "connected" | "disconnected" | "starting" | "failed";
  readonly tools: Map<string, unknown>; // Tool
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}
