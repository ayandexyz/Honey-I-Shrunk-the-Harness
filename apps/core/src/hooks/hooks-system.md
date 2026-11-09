# Hooks System

> Interception points for modifying agent behavior at key lifecycle points.

## Overview

The hooks system provides a way to intercept, modify, and respond to events during the agent's execution lifecycle. Hooks are the primary extension point for customizing agent behavior without modifying core loop logic.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Loop                                │
│                                                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐   │
│  │ Session  │───▶│  User    │───▶│  Pre     │───▶│  Tool    │   │
│  │ Start    │    │  Prompt  │    │  Tool    │    │  Use     │   │
│  └──────────┘    │  Submit  │    └──────────┘    └──────────┘   │
│                   └──────────┘                                   │
│                       │                    │                     │
│                       ▼                    ▼                     │
│               ┌──────────┐    ┌──────────┐    ┌──────────┐       │
│               │  Post    │◀───│Permis-   │◀───│  Pre    │       │
│               │  Tool    │    │  sion    │    │  Compact │       │
│               │  Use     │    │Request   │    └──────────┘       │
│               └──────────┘    └──────────┘           │            │
│                       │                    ▼                     │
│                       │            ┌──────────┐                  │
│                       └───────────▶│  Post   │◀─┐               │
│                                   │Compact  │  │               │
│                                   └──────────┘  │               │
│                                          ▲      │               │
└──────────────────────────────────────────┼──────┼───────────────┘
                                           │      │
                                   ┌───────┴──────┴───────┐
                                   │   Subagent Start     │
                                   │        /             │
                                   │   Subagent Stop      │
                                   └──────────────────────┘
                                           │
                                           ▼
                                   ┌──────────────┐
                                   │     Stop     │
                                   └──────────────┘
```

## Hook Event Types

| Event                | Purpose                                              | Can Block | Can Modify |
| -------------------- | ---------------------------------------------------- | --------- | ---------- |
| `SessionStart`       | Session's first prompt                               | No        | Yes        |
| `UserPromptSubmit`   | Once per prompt a person wrote, before it is stored  | Yes       | Yes        |
| `PreToolUse`         | Validate/modify tool call before execution           | Yes       | Yes        |
| `PermissionRequest`  | A tool call the rules would ask about                | Yes       | Yes        |
| `PostToolUse`        | Process tool results, inject context                 | No        | Yes        |
| `PostToolUseFailure` | A tool call failed                                   | No        | No         |
| `Notification`       | A person is needed (typed, see below)                | No        | No         |
| `PreCompact`         | Inspect/modify context before compaction             | Yes       | No         |
| `PostCompact`        | Verify/log compaction results                        | No        | Yes        |
| `SubagentStart`      | Initialize subagent context                          | No        | Yes        |
| `SubagentStop`       | Collect results from subagent                        | No        | Yes        |
| `TurnStart`/`TurnEnd`| Per model turn                                       | No        | No         |
| `Stop`               | The run for one prompt ended                         | No        | No         |
| `SessionEnd`         | The session ended, whatever ended it                 | No        | No         |

`UserPromptSubmit` skips harness-written prompts (task notifications, context)
and subagent briefs. A block refuses the prompt before anything is stored or
sent; `modifiedOutput` replaces the prompt; context is added as a context
message after it.

## Hooks for other programs

FreeCode has no code for any particular supervisor — a board, a notifier, a CI
wrapper. Such a program drives FreeCode through settings.json hooks alone, the
same contract Claude Code offers, so a tool written for Claude Code's hooks
works here unchanged.

**Scopes**, lowest priority first:

1. user — `~/.freecode/settings.json`
2. project — `.freecode/settings.json`
3. launch — `freecode --settings <file | inline JSON>` (any command; it is
   carried to the backend as `FREECODE_SETTINGS`)

Every scope's hooks run. A hook replaces another scope's only when both carry
the same explicit `name`.

**Entry shapes** — flat (`{ "name", "command", ... }`) or Claude Code's nested
`{ "matcher", "hooks": [ ... ] }`. Each handler is `type: "command"` (default)
or `type: "http"`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://127.0.0.1:7000/hooks/s1",
            "headers": { "X-Launch": "$LAUNCH_ID" },
            "allowedEnvVars": ["LAUNCH_ID"],
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

`timeout` is seconds. A header interpolates `$NAME` / `${NAME}` only for names
in `allowedEnvVars`; any other reads as empty.

**Input** — every external hook gets one JSON document: on stdin for a command,
as the request body for http. Claude Code's field names:

| Field | Events |
|---|---|
| `session_id`, `hook_event_name`, `cwd` | all |
| `agent_id`, `agent_type` | inside a subagent |
| `tool_name`, `tool_input`, `tool_use_id` | `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure` |
| `tool_response` / `error` | `PostToolUse` / `PostToolUseFailure` |
| `prompt` | `UserPromptSubmit` |
| `message`, `notification_type` | `Notification` |
| `source` | `SessionStart` (`startup`) |
| `reason` | `SessionEnd`: `clear` (another session took over the process) or `other` (exit) |
| `stop_hook_active` | `Stop` |
| the event's own fields, snake_cased | everything else |

`notification_type` is `permission_prompt` (a permission dialog is showing) or
`question` (the `question` tool is waiting; `message` is the question). A
Notification matcher selects by type.

**Output** — command stdout on exit `0`, or an http `2xx` body. FreeCode's JSON
(`block`, `reason`, `modifiedInput`, `modifiedOutput`, `context`,
`permissionDecision`) and Claude Code's (`decision: "block"`,
`continue: false` + `stopReason`, and `hookSpecificOutput` with
`permissionDecision`, `permissionDecisionReason`, `updatedInput`,
`additionalContext`, or a PermissionRequest `decision: {behavior, updatedInput,
message}`) are both read. An http hook that answers non-`2xx`, cannot be
reached, or times out is a non-blocking error: only an explicit decision
blocks.

## Usage

### Registering Hooks

```typescript
import { registerHook, getHookRuntime } from "./hooks";

// Register a command hook
registerHook("PreToolUse", "my-hook", {
  type: "command",
  command: "echo 'Blocking Write' && exit 2", // Exit 2 = block
  matcher: "Write",
});

// Register a callback hook
registerHook("PostToolUse", "log-tool", {
  type: "callback",
  callback: async (input, context) => {
    console.log(`Tool ${input.toolName} executed`);
    return { action: "continue" };
  },
});
```

### Using Hooks in Code

```typescript
import { getHookRuntime } from "./hooks";

const hooks = getHookRuntime();

// Before tool execution
const preResult = await hooks.runPreToolUse(toolCall, {
  sessionId: "sess-123",
  turnCount: 1,
  toolName: toolCall.tool,
});

if (!preResult.allowed) {
  // Tool was blocked by hook
  console.log(`Blocked: ${preResult.blockReason}`);
}

// After tool execution
const postResult = await hooks.runPostToolUse(toolCall, result, {
  sessionId: "sess-123",
  turnCount: 1,
  toolName: toolCall.tool,
});
```

## Hook Command Types

### Command Hook

Executes a shell command when the hook triggers.

```typescript
registerHook("PreToolUse", "block-dangerous", {
  type: "command",
  command: "./check-permissions.sh",
  shell: "bash",
  timeout: 5000,
});
```

The event document (see "Hooks for other programs") is written to the
command's stdin.

**Environment Variables Passed:**

- `CLAUDE_SESSION_ID` - Current session ID
- `CLAUDE_CWD` - Current working directory
- `CLAUDE_TOOL_NAME` - Name of the tool being executed
- `CLAUDE_TOOL_INPUT` - JSON string of tool input
- `CLAUDE_TOOL_OUTPUT` - The tool's output, PostToolUse only (capped at 30K chars)
- `CLAUDE_AGENT_ID` - Agent ID (if applicable)
- `CLAUDE_AGENT_TYPE` - Agent type (if applicable)

**Exit Codes:**

- `0` - Continue execution; stdout is additionalContext, or JSON (below)
- `2` - Block execution (output is the reason)
- anything else - Block with `Exit code N` (or the JSON `reason` if one was
  printed). The exit code always wins: `{"block": false}` + `exit 1` blocks.
  JSON is interpreted in full only on exit `0`.

**JSON Output Protocol:**

```json
{
  "block": true,
  "reason": "User rejected this operation",
  "modifiedInput": { "file": "new-path.txt" },
  "modifiedOutput": "replacement tool output (PostToolUse) or prompt (UserPromptSubmit)",
  "context": "Additional context to inject",
  "permissionDecision": "allow"
}
```

`permissionDecision` is read by `PermissionRequest` hooks only (ignored
elsewhere): `"allow"` or `"deny"` is an explicit decision; omitting the field
(or sending `"ask"`) means the hook has no opinion. A PermissionRequest hook
that matched but gave no explicit decision — including one that simply
printed nothing on exit `0` — resolves to **passthrough**, not an implicit
allow: the rules engine's own ask/allow/deny stands, the same way a silent
hook in Claude Code never auto-approves. This matters for a hook that proxies
to something that can time out (a bridge, a remote approver): on timeout it
should stay silent rather than ever defaulting to allow.

### Callback Hook

Executes an internal function when the hook triggers.

```typescript
registerHook("PreToolUse", "validate-input", {
  type: "callback",
  callback: async (input, context) => {
    if (input.toolName === "Bash" && input.toolInput.command.includes("rm")) {
      return { action: "block", reason: "No rm commands allowed" };
    }
    return { action: "continue" };
  },
});
```

**Callback Actions:**

- `{ action: "continue" }` - Proceed normally
- `{ action: "block", reason: string }` - Block and return reason
- `{ action: "modify", modifiedInput?: object, modifiedOutput?: object }` - Modify and continue

### Prompt Hook

Uses an LLM to evaluate whether to proceed (not yet implemented).

```typescript
registerHook("PreToolUse", "llm-approval", {
  type: "prompt",
  prompt: "Should I allow this operation?",
  model: "claude",
});
```

## Built-in Hooks

### rtk bash-rewrite (`builtin/rtk-rewrite.ts`)

An optional internal `PreToolUse` callback (matcher `bash`) that rewrites shell
commands to their compact [rtk](https://github.com/rtk-ai/rtk) equivalents
(e.g. `ls` → `rtk ls`) so the model reads less command output. Registered at
server startup via `registerRtkHook()`.

- **Optional & fail-open.** No-op unless rtk resolves; any failure (missing
  binary, timeout, unsupported platform) runs the original command unchanged.
- **Resolution** (`builtin/rtk-installer.ts`): a managed install under
  `~/.freecode/bin` → an `rtk` on `PATH` → a one-time consented download of a
  pinned release (`RTK_VERSION`), verified against the release's `checksums.txt`.
  The one-time offer is recorded in `~/.freecode/rtk-state.json`.
- **Scope:** the `bash` tool only (`read`/`grep`/`glob` bypass it).
- **Disable:** `FREECODE_RTK=0`. Not bundled into `build:bun` — pure runtime
  enhancement. Re-offer after declining by deleting `~/.freecode/rtk-state.json`.

## Hook Matcher Patterns

Hooks can use pattern matching to only trigger for specific tools:

```typescript
// Match any tool
matcher: "*";

// Match specific tool
matcher: "Write";

// Match tools with pattern
matcher: "Bash(git *)";

// Match multiple alternatives (pipe-separated)
matcher: "Write|Edit";

// Complex patterns
matcher: "Bash(npm * | yarn * | pnpm *)";
```

## Integration Points

### In Agent Loop (`agent/loop.ts`)

```typescript
// Session Start
await this.hooks.runSessionStart(ctx);

// User Prompt Submit (can modify prompt)
const result = await this.hooks.runUserPromptSubmit(prompt, ctx);
const modifiedPrompt = result.modifiedPrompt ?? prompt;

// Pre Tool Use (can block or modify)
const preResult = await this.hooks.runPreToolUse(toolCall, ctx);
if (!preResult.allowed) {
  /* blocked */
}
if (preResult.modifiedInput) {
  /* apply modifications */
}

// Permission Request (for dangerous operations)
// Runs AFTER the rules engine (permission/evaluate.ts). Decisions:
//   "allow" | "deny" — a matched hook gave an explicit `permissionDecision`
//   and overrides the rules outcome (except a rules deny, which is absolute
//   and short-circuits before hooks)
//   "passthrough" — no hook matched, OR one matched but gave no explicit
//   `permissionDecision` (silence is neutral, not an implicit allow); the
//   rules-engine decision stands either way
// See docs/specs/2026-07-18-permission-rules.md §5.
const permResult = await this.hooks.runPermissionRequest(toolCall, ctx);

// Post Tool Use (can modify output)
const postResult = await this.hooks.runPostToolUse(toolCall, result, ctx);

// Pre/Post Compact (memory compaction)
const preResult = await this.hooks.runPreCompact(ctx);
await this.hooks.runPostCompact(ctx, success);

// Subagent lifecycle
await this.hooks.runSubagentStart(name, ctx);
await this.hooks.runSubagentStop(name, ctx);

// Stop (cleanup)
await this.hooks.runStop(reason, ctx);
```

## Event Bus Integration

Hooks publish events to the bus when triggered:

```typescript
// Hook triggered
bus.publish({ type: "hook.triggered", hookName, event, sessionId });

// Hook blocked
bus.publish({ type: "hook.blocked", hookName, event, sessionId, reason });
```

## HookContext Type

```typescript
interface HookContext {
  sessionId: string; // Current session ID
  turnCount: number; // Current turn number
  toolName?: string; // Tool name (for tool hooks)
  [key: string]: unknown; // Additional context
}
```

## Type Definitions

### HookExecutionResult

```typescript
type HookExecutionResult =
  | {
      success: true;
      modifiedInput?: object;
      modifiedOutput?: unknown;
      additionalContext?: string;
    }
  | { success: false; blocked: true; blockReason?: string }
  | { success: false; blocked: false; error: string };
```

### HookResult (Callback)

```typescript
type HookResult =
  | { action: "continue" }
  | { action: "block"; reason: string }
  | { action: "modify"; modifiedInput?: object; modifiedOutput?: unknown };
```

## File Structure

```
src/hooks/
├── index.ts                 # Public API exports
├── runtime.ts               # HookRuntime interface + implementation
├── registry.ts              # Hook registration + matching
├── types.ts                 # Type definitions
├── payload.ts               # The JSON document external hooks receive
├── output.ts                # Reading a hook's reply (FreeCode + Claude Code shapes)
├── settings.ts              # settings.json scopes: user, project, launch
├── executors/
│   ├── index.ts             # Coordinator - executes hooks
│   ├── command.ts           # Shell command execution (document on stdin)
│   ├── http.ts              # POST the document to a URL
│   └── callback.ts          # Callback function execution
├── PreToolUse.ts            # Pre-tool hooks
├── PostToolUse.ts           # Post-tool hooks
├── PermissionRequest.ts     # Permission hooks
├── PreCompact.ts            # Pre-compaction hooks
├── PostCompact.ts           # Post-compaction hooks
├── SessionStart.ts          # Session start hooks
├── UserPromptSubmit.ts      # User prompt hooks
├── SubagentStart.ts         # Subagent start hooks
├── SubagentStop.ts          # Subagent stop hooks
├── Stop.ts                  # Stop hooks
├── Notification.ts          # Typed notifications (permission_prompt, question)
└── SessionEnd.ts            # Session end hooks
```
