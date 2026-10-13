// =============================================================================
// One isolated `claude -p` call on the owner's Claude subscription — the
// transport for every Claude judge: the eval judge (FREECODE_JUDGE_PROVIDER=
// claude-cli, eval/scorers/judge.ts) and agent-bench's primary judge
// (bench/agent-bench/runner/claude-complete.ts).
//
// Anthropic's own client in its documented headless mode — the route the
// subscription is for. Core's Anthropic provider in OAuth mode is NOT: it was
// refused for this organization ("OAuth authentication is currently not
// allowed for this organization", 2026-09-29). What keeps every call contained:
//   - `--system-prompt` replaces Claude Code's own, so the caller's system
//     prompt is verbatim in the system slot;
//   - `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`,
//     `--tools ""`: no owner settings, hooks, plugins, MCP servers, skills or
//     tools. Measured 2026-10-13: ~460 input tokens of preamble (environment
//     block only, no CLAUDE.md). `--bare` would be stricter but reads only
//     ANTHROPIC_API_KEY, never the subscription login;
//   - `--no-session-persistence` and an empty cwd: nothing kept, nothing read;
//   - the prompt goes on stdin, never argv (one argument caps at 128KB);
//   - optional `--json-schema`: the reply is schema-constrained and comes back
//     as `structured_output`, returned here as its JSON text.
// =============================================================================

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ClaudeCliCall {
  model: string;
  system: string;
  prompt: string;
  signal: AbortSignal;
  /** When set, the reply is constrained to it and returned as JSON text. */
  jsonSchema?: object;
  bin?: string;
}

export interface ClaudeCliReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export function claudeCliArgs(model: string, system: string, jsonSchema?: object): string[] {
  return [
    "-p",
    "--model",
    model,
    "--system-prompt",
    system,
    ...(jsonSchema ? ["--json-schema", JSON.stringify(jsonSchema)] : []),
    "--output-format",
    "json",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--tools",
    "",
    "--no-session-persistence",
  ];
}

/** The reply and usage from `--output-format json`, or throws with why there is none. */
export function parseClaudeCliResult(stdout: string, structured: boolean): ClaudeCliReply {
  const r = JSON.parse(stdout);
  const body = structured ? r.structured_output : r.result;
  if (r.is_error || body === undefined || body === null) {
    throw new Error(`claude -p returned no reply: ${String(r.result ?? r.subtype ?? "").slice(0, 300)}`);
  }
  const u = r.usage ?? {};
  return {
    text: structured ? JSON.stringify(body) : String(body),
    // input_tokens excludes cache reads and writes; all three were sent.
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
  };
}

export function runClaudeCli(call: ClaudeCliCall): Promise<ClaudeCliReply> {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-"));
    const child = spawn(call.bin ?? "claude", claudeCliArgs(call.model, call.system, call.jsonSchema), {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {}); // a child that exits early closes the pipe; `close` reports it
    child.stdin.end(call.prompt);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const onAbort = () => child.kill("SIGTERM");
    call.signal.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      call.signal.removeEventListener("abort", onAbort);
      fs.rmSync(dir, { recursive: true, force: true });
    };
    child.on("error", (err) => {
      done();
      reject(err);
    });
    child.on("close", (code) => {
      done();
      try {
        resolve(parseClaudeCliResult(stdout, call.jsonSchema !== undefined));
      } catch (err) {
        reject(new Error(code !== 0 ? `claude -p exited ${code}: ${stderr.trim().slice(-300)}` : (err as Error).message));
      }
    });
  });
}
