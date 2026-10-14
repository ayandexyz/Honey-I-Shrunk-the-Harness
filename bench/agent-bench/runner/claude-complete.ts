// =============================================================================
// `claude -p` on the owner's Claude subscription: the primary judge's transport
// since 2026-10-13. Spec: docs/specs/2026-09-29-commit-reconstruction-bench.md §4.6.
//
// Anthropic's own client in its documented headless mode — the route the
// Claude subscription is for. The earlier refusal ("OAuth authentication is
// currently not allowed for this organization", 2026-09-29) was core's
// provider sending the OAuth token to the API itself; this does not.
// The call itself — flags, isolation, parsing — lives in core
// (apps/core/src/utils/claude-cli.ts), shared with the eval judge. What keeps
// every call contained:
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

import { runClaudeCli } from "../../../apps/core/src/utils/claude-cli.js";
import { JUDGE_OUTPUT_SCHEMA } from "./codex-complete.js";
import type { JudgeUsage } from "./core-complete.js";
import type { Complete } from "./judge.js";

/** BuffBench's verdict, schema-constrained, through `claude -p`. */
export function claudeComplete(usage: JudgeUsage, bin = "claude"): Complete {
  return async (judge, system, prompt, signal) => {
    const u = (usage[judge.id] ??= { inputTokens: 0, outputTokens: 0, calls: 0 });
    u.calls += 1;
    const r = await runClaudeCli({
      model: judge.model,
      system,
      prompt,
      signal,
      jsonSchema: JUDGE_OUTPUT_SCHEMA,
      bin,
    });
    u.inputTokens += r.inputTokens;
    u.outputTokens += r.outputTokens;
    return r.text;
  };
}
