// =============================================================================
// Minimal LSP client — JSON-RPC over a server's stdio with Content-Length
// framing. Supports the subset freecode needs: diagnostics, hover, definition,
// references. Servers are spawned lazily and reused per (command, root).
// =============================================================================

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  serverForExtension,
  languageIdForExtension,
  type ServerSpec,
} from "./registry.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export interface DiagnosticPush {
  uri: string;
  diagnostics: Diagnostic[];
  /** Process-wide push counter: higher = newer, across every server. */
  seq: number;
}
let pushSeq = 0;

interface Diagnostic {
  range: { start: { line: number; character: number } };
  severity?: number;
  message: string;
  source?: string;
}

class ServerConnection {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private diagnostics = new Map<string, DiagnosticPush>();
  /** Open documents → their last sent version. */
  private versions = new Map<string, number>();
  private initialized: Promise<void>;
  private initError: Error | null = null;

  constructor(spec: ServerSpec, private root: string) {
    this.proc = spawn(resolveCommand(spec.command, root) ?? spec.command, spec.args, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.proc.on("error", (err) => {
      this.initError = err;
      for (const p of this.pending.values()) {
        p.reject(err);
      }
      this.pending.clear();
    });

    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on("data", () => {
      /* swallow server logs */
    });
    this.initialized = this.initialize().catch((err) => {
      this.initError = err;
    });
  }

  private async initialize(): Promise<void> {
    if (this.initError) {
      throw this.initError;
    }
    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      capabilities: {
        textDocument: {
          publishDiagnostics: {},
          synchronization: { didSave: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: {},
          references: {},
        },
      },
      workspaceFolders: [
        { uri: pathToFileURL(this.root).href, name: path.basename(this.root) },
      ],
    });
    this.notify("initialized", {});
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      try {
        this.handleMessage(JSON.parse(body));
      } catch {
        /* ignore malformed message */
      }
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = msg.error as { message?: string };
        p.reject(new Error(err.message ?? "LSP error"));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const params = msg.params as { uri: string; diagnostics: Diagnostic[] };
      this.diagnostics.set(params.uri, {
        uri: params.uri,
        diagnostics: params.diagnostics ?? [],
        seq: ++pushSeq,
      });
    }
  }

  private send(payload: Record<string, unknown>): void {
    const json = JSON.stringify(payload);
    const message = `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
    this.proc.stdin.write(message);
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP request '${method}' timed out`));
        }
      }, 15_000);
    });
  }

  async openDocument(file: string): Promise<void> {
    await this.initialized;
    if (this.initError) {
      throw this.initError;
    }
    const uri = pathToFileURL(file).href;
    if (this.versions.has(uri)) return;
    const text = fs.readFileSync(file, "utf-8");
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: languageIdForExtension(path.extname(file)),
        version: 1,
        text,
      },
    });
    this.versions.set(uri, 1);
  }

  /**
   * Tell the server the file on disk changed. Drops the URI's last push first,
   * so a pre-edit push is never read as this edit's result.
   */
  async syncDocument(file: string): Promise<void> {
    const uri = pathToFileURL(file).href;
    const version = this.versions.get(uri);
    if (version === undefined) return this.openDocument(file);
    this.diagnostics.delete(uri);
    this.versions.set(uri, version + 1);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version: version + 1 },
      contentChanges: [{ text: fs.readFileSync(file, "utf-8") }],
    });
    this.notify("textDocument/didSave", { textDocument: { uri } });
  }

  pushes(): DiagnosticPush[] {
    return [...this.diagnostics.values()];
  }

  async diagnosticsFor(file: string): Promise<Diagnostic[]> {
    const uri = pathToFileURL(file).href;
    await this.openDocument(file);
    // Diagnostics arrive asynchronously after didOpen; poll briefly.
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (this.diagnostics.has(uri)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    return this.diagnostics.get(uri)?.diagnostics ?? [];
  }

  async requestAt(
    method: string,
    file: string,
    line: number,
    character: number,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> {
    await this.openDocument(file);
    return this.request(method, {
      textDocument: { uri: pathToFileURL(file).href },
      position: { line, character },
      ...extra,
    });
  }

  dispose(): void {
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
  }
}

// Pool of live servers keyed by command + root.
const pool = new Map<string, ServerConnection>();

// Where a server binary is looked for, first hit wins: the project's own
// install, PATH, then freecode's (spec 2026-10-14-edit-time-diagnostics §1.2).
export const LSP_INSTALL_DIR = path.join(os.homedir(), ".freecode", "lsp");

export function resolveCommand(command: string, root: string): string | undefined {
  if (path.isAbsolute(command)) return fs.existsSync(command) ? command : undefined;
  const dirs = [
    path.join(root, "node_modules", ".bin"),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(LSP_INSTALL_DIR, "node_modules", ".bin"),
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// npm-installable servers → the packages that make them work.
const NPM_PACKAGES: Record<string, string[]> = {
  "typescript-language-server": ["typescript-language-server", "typescript"],
  "pyright-langserver": ["pyright"],
};
const installs = new Set<string>();

/** Install a missing server into LSP_INSTALL_DIR, once per process, in the background. */
function installInBackground(command: string): void {
  const packages = NPM_PACKAGES[command];
  if (!packages || installs.has(command) || process.env.FREECODE_LSP_AUTO_INSTALL === "0") return;
  installs.add(command); // ponytail: a failed install is not retried until restart
  try {
    fs.mkdirSync(LSP_INSTALL_DIR, { recursive: true });
    const child = spawn(
      "npm",
      ["install", "--prefix", LSP_INSTALL_DIR, "--no-audit", "--no-fund", "--silent", ...packages],
      { stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no npm: diagnostics stay off for this language */
  }
}

function getConnection(
  file: string,
  root: string,
  opts: { install?: boolean } = {},
): ServerConnection | undefined {
  const spec = serverForExtension(path.extname(file));
  if (!spec) return undefined;
  if (opts.install && !resolveCommand(spec.command, root)) {
    installInBackground(spec.command);
    return undefined;
  }
  const key = `${spec.command}::${root}`;
  let conn = pool.get(key);
  if (!conn) {
    try {
      conn = new ServerConnection(spec, root);
    } catch {
      return undefined;
    }
    pool.set(key, conn);
  }
  return conn;
}

export function hasServerFor(file: string): boolean {
  return serverForExtension(path.extname(file)) !== undefined;
}

export async function getDiagnostics(
  file: string,
  root: string,
): Promise<Diagnostic[]> {
  const conn = getConnection(file, root);
  if (!conn) throw new Error("No LSP server available for this file type");
  return conn.diagnosticsFor(file);
}

export async function lspRequest(
  operation: "hover" | "definition" | "references",
  file: string,
  root: string,
  line: number,
  character: number,
): Promise<unknown> {
  const conn = getConnection(file, root);
  if (!conn) throw new Error("No LSP server available for this file type");
  const method =
    operation === "hover"
      ? "textDocument/hover"
      : operation === "definition"
        ? "textDocument/definition"
        : "textDocument/references";
  const extra =
    operation === "references" ? { context: { includeDeclaration: false } } : {};
  return conn.requestAt(method, file, line, character, extra);
}

/** Open a file on its server so its first push becomes a baseline. */
export async function openFile(file: string, root: string): Promise<boolean> {
  const conn = getConnection(file, root, { install: true });
  if (!conn) return false;
  await conn.openDocument(file);
  return true;
}

/** didOpen / didChange + didSave for a file just written. */
export async function syncFile(file: string, root: string): Promise<boolean> {
  const conn = getConnection(file, root, { install: true });
  if (!conn) return false;
  await conn.syncDocument(file);
  return true;
}

/** Latest push per document, across every server rooted at `root`. */
export function diagnosticPushes(root: string): DiagnosticPush[] {
  const out: DiagnosticPush[] = [];
  for (const [key, conn] of pool) if (key.endsWith(`::${root}`)) out.push(...conn.pushes());
  return out;
}

export function disposeAll(): void {
  for (const conn of pool.values()) conn.dispose();
  pool.clear();
}

export type { Diagnostic };
