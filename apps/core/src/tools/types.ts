export interface ToolContext {
  /**
   * Effective working directory for this tool call. When projectPath is
   * present, callers must set cwd to that same resolved project root.
   */
  cwd: string;
  sessionId?: string;
  abort?: AbortSignal;
  /**
   * Id of the tool call being served. Set by the loop so a long-running tool
   * can stream partial output back to the frontend against the row the user is
   * already looking at (see the live tail in `bash.ts`).
   */
  toolCallId?: string;
  /** The resolved project root, when the call belongs to a project session. */
  projectPath?: string;
  /**
   * The spawning loop's agent mode. Only the `agent` tool reads it, to decide
   * what a subagent inherits — a subagent that silently dropped to `build`
   * under a `danger` parent prompted for permissions the user had already
   * turned off, in the middle of somebody else's turn.
   */
  agentMode?: import("../agent/types.js").AgentMode;
  /**
   * The spawning loop's effective agent envelope, when it has one. Only the
   * `agent` tool reads it: what a subagent inherits, and cannot widen (§5.4).
   */
  envelope?: import("../agent/definitions/types.js").AgentEnvelope;
  /** The spawning run's provider and model — what a subagent inherits. */
  provider?: string;
  model?: string;
  /**
   * Present only inside an unattended run (`freecode night`): `question`
   * answers itself through it and `finish_iteration` reports through it.
   * Absent in every attended session.
   */
  unattended?: import("../autonomous/types.js").UnattendedContext;
  fileCache?: FileCache;
  hooks?: unknown;
  startTime?: number;
}

// =============================================================================
// File Cache for LRU caching of file reads
// =============================================================================

export interface FileCacheEntry {
  content: string;
  stat: { mtime: number; size: number };
  lineCount?: number;
}

export interface FileCache {
  get(path: string): FileCacheEntry | undefined;
  set(path: string, entry: FileCacheEntry): void;
  invalidate(path: string): void;
  clear(): void;
}

export interface ToolResult {
  title: string;
  output: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDef<P = unknown, R extends ToolResult = ToolResult> {
  id: string;
  description: string;
  parameters: JsonSchema;
  execute: (params: P, ctx: ToolContext) => Promise<R>;
}

export type ToolRegistry = Record<string, ToolDef>;

export interface JsonSchemaProperty {
  description?: string;
  type?: string;
  enum?: string[];
  items?: JsonSchemaProperty | JsonSchemaProperty[]; // For array items
}

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  items?: JsonSchemaProperty | JsonSchemaProperty[]; // For array types
}
