# FreeCode environment variables

Every `FREECODE_*` variable the code reads, what it does, and its default.
Generated from the source on 2026-10-13. Variables used only inside tests are
left out.

**How to read this:**

- **Unset is the normal case.** Every default below is what you get with
  nothing exported. Export a variable only to change that.
- **On/off flags:** where a row says `1` / `0`, an env value **beats the
  settings files** (`~/.freecode/settings.json`, `<project>/.freecode/settings.json`).
  Unset means "use the settings file, else the default".
- **`eval ab`** marks a variable `pnpm eval ab` can flip between its two sides.
  Such a variable is read on every call, so it also works in a running
  daemon. Only these are accepted as `env:NAME=value` variants
  (`apps/core/src/eval/ab.ts`, `VARIABLE_ENV_KEYS`).
- **Numbers:** an empty or unparseable value is ignored with a warning, never
  read as 0 (`utils/env.ts`).
- **Shell profiles:** a variable exported in `~/.bashrc` applies to every
  FreeCode run started from that shell, including evals and benches. A
  forgotten `FREECODE_COMPACT_TARGET_TOKENS=40000` there made one session
  compact 8 times in 8 minutes.

---

## Compaction and context size

| Variable | Default | Purpose |
|---|---|---|
| `FREECODE_COMPACT_TARGET_TOKENS` | `120000` | Cost ceiling for the conversation. Compaction fires at whichever comes first: the model's window, or this. Raise it (e.g. `500000`) to use more of a large window; lower it to compact more often. **Too low compacts every minute**: every request already carries ~11K tokens of system prompt and tools. |
| `FREECODE_AUTO_COMPACT_TOKENS` | unset | Test override: compact as soon as the context reaches this many tokens, ignoring the window and the target. For checking the trigger by hand. |
| `FREECODE_COMPACT_RESTORE` | on | `0` stops re-attaching the 5 most recent files, the list of touched files and loaded skills after a compaction (`compaction/restore.ts`). `eval ab`. |
| `FREECODE_TOOL_RESULT_BUDGET_CHARS` | `200000` | How many characters of old tool results a request may carry before older ones are replaced by a marker. `0` prunes all of them. |
| `FREECODE_MAX_TURN_TOKENS` | off | Spend circuit breaker: stop a run once it has billed this many tokens (input + output). Backstop for a runaway loop, not a normal limit. |

## Agent loop behaviour

| Variable | Default | Purpose |
|---|---|---|
| `FREECODE_REPEATED_ERROR` | on | `0` turns off signal E, the "same error back after edits" detector and its one nudge (`agent/repeated-error.ts`). `eval ab`. |
| `FREECODE_DISABLE_REDIRECT` | redirect off | `0` turns trajectory redirection **on** (an extra model call that advises a stuck run), `1` forces it off. Two-way, beats `redirect.enabled`. `eval ab`. |
| `FREECODE_AUTO_POKE` | off | `1` sends a model that stopped with open todos back to finish them (max 3 per run). `eval ab`. |
| `FREECODE_CONFIDENCE_GATE` | off | `1`: a todo marked done with a +40 confidence jump in one call is sent back to verify. `eval ab`. |
| `FREECODE_HILLCLIMB_GATE` | off | `1`: a todo rated hard to hill-climb (below 90) gets a reframe prompt. `eval ab`. |
| `FREECODE_TODO_NUDGE` | current | `legacy` restores the old "you haven't used todowrite" cadence (every 3/5 turns instead of 10). `eval ab`. |
| `FREECODE_STEERING_MODE` | one at a time | `all` delivers every queued steer message at once instead of one per tool batch. |
| `FREECODE_TASK_NOTIFY` | on | `0` turns off background-task notifications: background agents fall back to foreground, background shells must be polled, `monitor` is unavailable. |
| `FREECODE_BRANCH_SUMMARY` | model | `heuristic` summarises an abandoned `/tree` branch without a model call (tests, offline). |

## Tools

| Variable | Default | Purpose |
|---|---|---|
| `FREECODE_READ_DEDUP` | on | `0` always returns a file's full content, never the "unchanged since you last read it" stub. |
| `FREECODE_READ_LINE_NUMBERS` | off | `1` prefixes each line of `read` output with its number. `eval ab`. |
| `FREECODE_BASH_COMPRESS` | off | `1` compresses noisy bash output (source is never touched; search output only collapses duplicate lines). Off because its A/B measured +12% tokens: the model pages back what was elided. `eval ab`. |
| `FREECODE_OUTPUT_MAX_CHARS` | `30000` | Characters of one tool output shown to the model (head + tail); the rest stays fetchable with the `output` tool. Also caps payload fields handed to hooks. |
| `FREECODE_OUTPUT_TAIL_CHARS` | `6000` | How much of that budget is the tail of the output. |
| `FREECODE_OUTPUT_LINES` | `200` | Default line window per `output` tool call. |
| `FREECODE_OUTPUT_STORE_BYTES` | 16 MB | Per-session store of full tool outputs; oldest evicted first. |
| `FREECODE_OUTPUT_STORE_SESSIONS` | `50` | How many sessions' output stores stay live at once. |
| `FREECODE_LSP_SERVERS` | built-in table | JSON mapping file extensions to language servers, e.g. `{".rs": {"command": "rust-analyzer", "args": []}}`. Adds to or overrides the built-ins. |
| `FREECODE_RTK` | on if `rtk` is installed | `0` stops rewriting bash commands to their compact `rtk` equivalents. |

## Prompt and context

| Variable | Default | Purpose |
|---|---|---|
| `FREECODE_SYSTEM_FILE` | shipped prompt | Path to a file that replaces the shipped system prompt (a user `SYSTEM.md` still wins). For prompt experiments. `eval ab`. |
| `FREECODE_APPEND_SYSTEM_FILE` | none | Path to a file appended after the system prompt and any `APPEND_SYSTEM.md`. `eval ab`. |
| `FREECODE_MODEL_OVERLAY` | on | `0` drops the per-model prompt overlays (fixes for known model gaps). `eval ab`. |
| `FREECODE_CONTEXT_FRAMING` | current | `legacy` restores the pre-2026-09-21 project-context framing. Measurement only. `eval ab`. |
| `FREECODE_EPHEMERAL_TAIL` | on | `0` puts per-turn state (memory recalls, todos, reminders) back in the system prompt instead of a trailing message. Breaks the prompt cache; measurement only. `eval ab`. |

## Prompt cache

| Variable | Default | Purpose |
|---|---|---|
| `FREECODE_CACHE_TTL` | `5m` | `1h` asks Anthropic for the extended cache: writes cost 2× instead of 1.25×, far fewer cold starts after a pause. The TUI's idle warning follows it. |
| `FREECODE_CACHE_WARMING` | `off` | `idle` or `streaming` re-sends the last request with 1 output token before the cache expires, when the expected saving is ≥ $0.05. |
| `FREECODE_CACHE_MISS_NOTICES` | on | `0` mutes the "unexplained cache miss" notices; the accounting still runs. |
| `FREECODE_DEBUG_CACHE` | off | `1` logs a fingerprint of every cacheable prompt segment, to find what broke a prefix. |

## Memory

| Variable | Default | Purpose |
|---|---|---|
| `FREECODE_DISABLE_MEMORY_RECALL` | recall on | `1` stops injecting recalled memories automatically (the `memory` tool still works). `eval ab`. |
| `FREECODE_DISABLE_MEMORY_EXTRACTION` | extraction on | `1` stops mining finished turns for new memories. `eval ab`. |
| `FREECODE_DISABLE_MEMORY_CONSOLIDATION` | consolidation on | `1` stops the once-a-day memory merge. `eval ab`. |
| `FREECODE_DISABLE_MEMORY_JUDGE` | judge off | `0` turns the retrieval judge **on**, `1` forces it off. Two-way, beats the settings files. `eval ab`. |
| `FREECODE_MEMORY_PROMPT` | current | `legacy` restores the pre-2026-09-07 recalled-memory header. `eval ab`. |
| `FREECODE_EXIT_FLUSH_BUDGET_MS` | `5000` | How long session end waits for the final memory flush. `0` skips the wait. |

## Providers, auth and models

| Variable | Default | Purpose |
|---|---|---|
| `FREECODE_ANTHROPIC_AUTH` | API key if one is configured, else a stored login | `oauth` uses your Claude Pro/Max subscription login, `api-key` the API key. Beats `providers.anthropic.authMode` in config. |
| `FREECODE_OPENAI_AUTH` | stored choice | Same for OpenAI: `oauth` uses your ChatGPT Plus/Pro login through the Codex backend. |
| `FREECODE_GEMINI_WEB_TOOLS` | on | `0` turns off the text-protocol tool bridge for the Gemini web-session provider. |
| `FREECODE_HEADER_TIMEOUT_MS` | `300000` | Give up on a model request with no response headers after this long. `0` disables. |
| `FREECODE_SSE_STALL_TIMEOUT_MS` | `180000` | Give up on a streaming response silent for this long. `0` disables. |
| `FREECODE_MODELS_URL` | `https://models.dev/api.json` | Where the model catalogue is fetched from: point it at an internal mirror for an air-gapped install. |
| `FREECODE_MODELS_TIMEOUT_MS` | `10000` | Timeout per catalogue fetch attempt. |
| `FREECODE_MODELS_CACHE_FILE` | `~/.freecode/cache/models-dev.json` | Where the catalogue is cached. Tests point it at a fixture. |
| `FREECODE_PRICING_FILE` | `~/.freecode/pricing.json` | Per-model price overrides (USD per million tokens). |

## Integrations and extensions

| Variable | Default | Purpose |
|---|---|---|
| `FREECODE_MCP_CLAUDE_CODE` | on | `0` stops importing Claude Code's MCP servers (`~/.claude.json`, `.mcp.json`). |
| `FREECODE_CLAUDE_CODE_AGENTS` | on | `0` skips subagent definitions from `~/.claude/agents` and `<project>/.claude/agents`. |
| `FREECODE_DISABLE_EXTENSIONS` | extensions load | `1` loads no extensions at all. |
| `FREECODE_TRUST_PROJECT_EXTENSIONS` | off | `1` loads `<project>/.freecode/extensions/` without the project being in `extensions.trustedProjects`. An extension is arbitrary code, so use it only on repos you trust. |
| `FREECODE_HOOK_URL` | unset | URL of a supervising board (AgentBoard): reports activity over HTTP and lets the board answer permission requests. Inert when unset. |
| `FREECODE_AGENT_FOLD` | on | `0` turns off reporting to the agent-fold bridge (already inert when the bridge isn't running). |
| `FREECODE_CHECKPOINTS` | on | `0` stops the per-turn file snapshots behind `/rewind`. |

## Paths

| Variable | Default | Purpose |
|---|---|---|
| `FREECODE_HOME` | `~/.freecode` | Root for FreeCode's own data (checkpoints and more). Also where the installer puts builds. |
| `FREECODE_SNAPSHOTS_HOME` | `$FREECODE_HOME/snapshots` | Where checkpoint shadow repos live. |
| `FREECODE_RUNS_HOME` | `~/.freecode/runs` | Where overnight-run manifests and sidecars live. |
| `FREECODE_BACKGROUND_DIR` | `~/.freecode/background` | Ledger of running background agents and shells, for reporting lost ones after a restart. |
| `FREECODE_ROOT` | current dir | Dev only: where the TUI looks for the monorepo when it spawns core from source. |

## TUI, install and updates

| Variable | Default | Purpose |
|---|---|---|
| `FREECODE_NO_UPDATE` | off | `1` / `true` / `yes` hides the "new version available" notice. |
| `FREECODE_IDLE_NUDGE_TOKENS` | `100000` | Context size above which the TUI warns that an idle gap let the prompt cache expire. `0` disables. |
| `FREECODE_INSTALL_DIR` | `~/.local/bin` | Where `install.sh` / `uninstall.sh` put the launcher. |
| `FREECODE_DEBUG` | off | Any value turns on debug logging (and echoes MCP servers' stderr). |

## Evals (`pnpm eval`)

| Variable | Default | Purpose |
|---|---|---|
| `FREECODE_JUDGE_PROVIDER` | unset | Provider for the judged suite's grader. Must not be the provider under test. Required by `pnpm eval:gate`. |
| `FREECODE_JUDGE_MODEL` | provider default | Model for that grader. |
| `FREECODE_EVALS_DIR` | `./evals` | Where the case files are read from. |
| `FREECODE_EVAL_HOME` | `~/.freecode` | Where eval history (`eval_runs.jsonl`) is kept. |
| `FREECODE_EVAL_KEEP_SANDBOX` | off | `1` keeps each trial's sandbox dir for inspection instead of deleting it. |
| `FREECODE_EVAL_TRIAL_TIMEOUT_MS` | `300000` | Per-trial time limit. |
| `FREECODE_EVAL_VERIFY_TIMEOUT_MS` | `60000` | Time limit for a coding case's `verify` command. |
| `FREECODE_EVAL_MEMORY_DRAIN_TIMEOUT_MS` | `10000` | How long a trial waits for background memory work before its cost is marked unknown. |

## Build and internal

These are set by FreeCode's own build or supervisor. You should not need to set them.

| Variable | Set by | Purpose |
|---|---|---|
| `FREECODE_BUNDLED` | `pnpm build:bun` | Marks the self-contained release binary: core runs in-process, and the bundled `rg` and native libs are looked up next to the executable. |
| `FREECODE_BUILD_VERSION` | the build | Version string baked into the binary (no `package.json` to read inside it). |
| `FREECODE_BUN_TARGET`, `FREECODE_BUN_OUTFILE` | release CI | Cross-compile target and output path for `scripts/build-bun.mjs`. |
| `FREECODE_NIGHT_WORKER`, `FREECODE_NIGHT_RUN_ID`, `FREECODE_NIGHT_SCHEDULED_FOR` | `freecode night --detach / --at` | Hand-off from the overnight-run launcher to its detached worker. |
| `__FREECODE_REEXECED` | the release binary | Guards its one-time re-exec with `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` set to its own folder (so the bundled onnxruntime loads) from looping. |
