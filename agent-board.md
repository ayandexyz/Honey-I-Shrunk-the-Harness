# FreeCode

FreeCode is an open-source CLI-driven AI coding assistant — think Claude Code, but provider-agnostic.

**Core idea:** a thin-client architecture. All intelligence (agent loop, tools, providers, memory, sessions) lives in one backend, `apps/core`, which runs as a long-lived daemon. Multiple frontends — a terminal UI (`apps/tui`), VS Code extension, web app, and a Tauri desktop app — are "dumb" renderers that talk to the core purely over JSON-RPC (stdin/stdout or websockets). No frontend contains business logic.

**What the core does:**
- Runs a single agentic tool-use loop: the model gets project context (file tree, git state) plus a toolset (`read`, `edit`, `write`, `bash`, `grep`, `glob`, subagents, etc.) and drives work by emitting tool calls, executed in parallel batches where safe, looped until it stops.
- Talks to ~198 AI providers (Anthropic, OpenAI, Gemini, MiniMax, DeepSeek, etc.) through the Vercel AI SDK via one generic provider driver, so swapping models is trivial. Supports streaming, tool calling, prompt caching, extended thinking.
- Has durable sessions (resume/fork/export), context compaction for long conversations, cross-session persistent memory (with a derived knowledge graph), a permission system (plan/build/review/explore/danger modes), hooks, skills, MCP client support, subagents, checkpoints/rewind (git-based snapshotting of edits), and an eval harness for measuring whether behavior changes actually help.
- It's also building toward "overnight runs" — fully unattended multi-hour agent loops that commit their own work to a branch.

The repo itself is heavily spec-driven (`docs/specs/`) and eval-driven — changes to agent behavior are expected to be validated with A/B evals rather than eyeballed, and there's a clear doc hierarchy (`TODO.md`/`ROADMAP.md`/`DECISIONS.md`) for tracking debt, planned features, and intentional behavior.
