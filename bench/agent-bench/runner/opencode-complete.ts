// =============================================================================
// `opencode run` on OpenCode's own client: the transport for the DeepSeek
// judge. Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md §4.6.
//
// Why a CLI and not core's `opencode` provider: OpenCode Zen's free tier is
// refused to every client that is not OpenCode itself ("FreeTierError: OpenCode's
// free tier can only be used from within OpenCode", re-measured 2026-10-17 with
// and without an API key), and no Zen credential exists on this machine. The
// model is reachable only through OpenCode's own binary, exactly as Haiku is
// reachable only through `claude -p` and GPT through `codex exec`.
//
// What keeps a call contained:
//   - the message goes on stdin, never argv: Linux caps one argument at 128KB
//     (MAX_ARG_STRLEN) and a judge prompt is ~118K tokens;
//   - the working directory is an empty throwaway, so a judge that decides to
//     look around finds nothing (it is handed every file it needs);
//   - no `--auto`: a tool that asks for permission is not approved from under
//     the operator, so a judging run cannot act on the machine.
//
// Disclosure this transport forces into the report: OpenCode prepends its own
// (`build`) agent setup and tool definitions, so this judge's context is not a
// bare completion the way Haiku's and GPT's are. Nobody has measured the delta.
// `opencode run --format json` reports no token usage for this model (v2.0.32,
// re-measured 2026-10-17), so the panel records `calls` only — the free tier
// has no USD price to report either.
// =============================================================================

import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { JudgeUsage } from "./core-complete.js";
import type { Complete } from "./judge.js";

/** `opencode run` with machine-readable events; the message is read from stdin. */
export function opencodeArgs(model: string): string[] {
  return ["run", "-m", model, "--format", "json"];
}

/**
 * The reply from `opencode run --format json`: its `text` parts, in order.
 * Measured v2.0.32: a one-shot reply is `step_start` then one or more `text`
 * events. Anything else is not the reply — a tool's output is not, and a torn
 * line is not.
 */
export function opencodeText(jsonl: string): string {
  let out = "";
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"text"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; part?: { text?: unknown } };
      if (event.type === "text" && typeof event.part?.text === "string") out += event.part.text;
    } catch {
      // a torn line is not a text part
    }
  }
  return out;
}

/** One `opencode run` call, message in, reply text out. */
function runOpencode(
  model: string,
  message: string,
  signal: AbortSignal,
  opts: { bin?: string; usage?: JudgeUsage; usageKey?: string },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-judge-"));
    const child = spawn(opts.bin ?? "opencode", opencodeArgs(model), {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Written, then closed: with stdin left open, `opencode run` waits for more.
    child.stdin.on("error", () => {}); // a child that exits early closes the pipe; `close` reports it
    child.stdin.end(message);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      fs.rmSync(dir, { recursive: true, force: true });
      reject(err);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      // No usage events from `opencode run`, so a call is all there is to count.
      if (opts.usage && opts.usageKey) {
        const u = (opts.usage[opts.usageKey] ??= { inputTokens: 0, outputTokens: 0, calls: 0 });
        u.calls += 1;
      }
      const text = opencodeText(stdout);
      fs.rmSync(dir, { recursive: true, force: true });
      if (code !== 0 || !text) {
        reject(new Error(`opencode run exited ${code}: ${stderr.trim().slice(-300)}`));
      } else {
        resolve(text);
      }
    });
  });
}

export function opencodeComplete(usage: JudgeUsage, bin = "opencode"): Complete {
  return async (judge, system, prompt, signal) =>
    runOpencode(`${judge.provider}/${judge.model}`, `${system}\n\n---\n\n${prompt}`, signal, {
      bin,
      usage,
      usageKey: judge.id,
    });
}
