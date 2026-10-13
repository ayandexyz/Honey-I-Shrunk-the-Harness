// =============================================================================
// `claude -p` on the owner's Claude subscription: the primary judge's transport
// since 2026-10-13. Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md §4.6.
//
// Anthropic's own client in its documented headless mode — the route the
// Claude subscription is for. The earlier refusal ("OAuth authentication is
// currently not allowed for this organization", 2026-09-29) was core's
// provider sending the OAuth token to the API itself; this does not.
// What keeps every call contained:
//   - `--json-schema`: the reply is schema-constrained (`structured_output`),
//     as BuffBench's `set_output` tool and codex's `--output-schema` are;
//   - `--system-prompt`: BuffBench's system prompt replaces Claude Code's own,
//     so it is verbatim in the system slot, not prefixed to the message;
//   - `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`,
//     `--tools ""`: no owner settings, hooks, plugins, MCP servers, skills or
//     tools. Measured 2026-10-13: ~460 input tokens of preamble (environment
//     block only, no CLAUDE.md). `--bare` would be stricter but reads only
//     ANTHROPIC_API_KEY, never the subscription login;
//   - `--no-session-persistence` and an empty cwd: nothing kept, nothing to read.
// =============================================================================

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { JUDGE_OUTPUT_SCHEMA } from "./codex-complete.js";
import type { JudgeUsage } from "./core-complete.js";
import type { Complete } from "./judge.js";

export function claudeArgs(model: string, system: string): string[] {
  return [
    "-p",
    "--model",
    model,
    "--system-prompt",
    system,
    "--json-schema",
    JSON.stringify(JUDGE_OUTPUT_SCHEMA),
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

/** The verdict and usage from `--output-format json`, or throws with why there is none. */
export function parseClaudeResult(stdout: string): {
  text: string;
  inputTokens: number;
  outputTokens: number;
} {
  const r = JSON.parse(stdout);
  if (r.is_error || r.structured_output === undefined) {
    throw new Error(`claude -p returned no verdict: ${String(r.result ?? r.subtype ?? "").slice(0, 300)}`);
  }
  const u = r.usage ?? {};
  return {
    text: JSON.stringify(r.structured_output),
    // input_tokens excludes cache reads and writes; all three were sent.
    inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
  };
}

export function claudeComplete(usage: JudgeUsage, bin = "claude"): Complete {
  return (judge, system, prompt, signal) =>
    new Promise<string>((resolve, reject) => {
      // A judge reads nothing from disk: an empty dir leaves it nothing to find.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-judge-"));
      const child = spawn(bin, claudeArgs(judge.model, system), { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
      // The prompt goes on stdin, never argv: one argument caps at 128KB and a
      // judge prompt is ~118K tokens (codex-complete.ts, E2BIG).
      child.stdin.on("error", () => {}); // a child that exits early closes the pipe; `close` reports it
      child.stdin.end(prompt);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const onAbort = () => child.kill("SIGTERM");
      signal.addEventListener("abort", onAbort, { once: true });
      const done = () => {
        signal.removeEventListener("abort", onAbort);
        fs.rmSync(dir, { recursive: true, force: true });
      };
      child.on("error", (err) => {
        done();
        reject(err);
      });
      child.on("close", (code) => {
        done();
        const u = (usage[judge.id] ??= { inputTokens: 0, outputTokens: 0, calls: 0 });
        u.calls += 1;
        try {
          const r = parseClaudeResult(stdout);
          u.inputTokens += r.inputTokens;
          u.outputTokens += r.outputTokens;
          resolve(r.text);
        } catch (err) {
          const why = code !== 0 ? `claude -p exited ${code}: ${stderr.trim().slice(-300)}` : (err as Error).message;
          reject(new Error(why));
        }
      });
    });
}
