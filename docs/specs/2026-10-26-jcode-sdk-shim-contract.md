# jcode-sdk shim contract — apps/desktop backend

Tracks the exact surface the `jcode-sdk` shim crate (see "Desktop App" in
CLAUDE.md/AGENTS.md) needs to implement so `apps/desktop`'s harness + UI
compile and run unmodified against freecode's `apps/core` instead of Jcode's
real backend. Edit this doc's **Status** column as work lands or scope
changes — this is the thing to strip/add rows on, not the narrative plan in
CLAUDE.md.

**Status legend**: `todo` · `stub` (compiles, returns "unsupported") ·
`done` · `cut` (decided out of scope, not building)

Source: `jcode-sdk/src/client.rs` (1938 lines) in the sibling `jcode`
checkout, mapped against `packages/shared/src/ipc/protocol.ts` (960 lines).
Produced 2026-10-26, Phase 1 of the desktop backend rewire.

## Transport

Not a method-by-method mapping — the whole transport layer is a rewrite.

| Item | jcode-sdk | freecode | Status |
|---|---|---|---|
| Connection | `UnixTransport` — Unix domain socket, length-prefixed binary frames, `Hello`/`HelloOk` handshake with capability negotiation | `apps/core` spawned as a child process, newline-delimited JSON over stdin/stdout, no handshake | todo |
| Request/reply correlation | `reply_to` field on frames | JSON-RPC `id` | todo |
| Capability checks | `JcodeClient.capabilities`/`.supports()` | no equivalent | todo — stub to "everything supported" or strip call sites |

## Session + turn methods

| jcode_sdk | freecode | Shape | Status |
|---|---|---|---|
| `connect`/`connect_with` | spawn `apps/core` + open stdio | new transport | todo |
| `create_session`/`create_session_with_options` | `session.start` | `working_dir`→`projectPath`; no `system_prompt` override param on freecode's side — needs adding or dropping | todo |
| `attach_session` | `session.resume` | close | todo |
| `list_sessions`/`list_sessions_limited` | `session.list` | no `limit` param on freecode | todo |
| `archive_session` | `session.archive` | close | todo |
| `fork_session` | `session.fork` | close | todo |
| `send_message`/`send_message_with_reminder` | `session.send` | different control flow: jcode fires + separately awaits `MessageAccepted`; freecode resolves with full `TurnResult` directly (or `{queued:true}`) — real translation needed | todo |
| `cancel` | `session.stop` | close | todo |
| `compact` | `session.compact` | close | todo |
| `rename_session` | — | **gap**, no freecode method | todo — decide: add IPC method, or cut |
| `set_model` | `config.setCurrentModel` | per-process not per-session in freecode | todo |
| `list_models` | `models.list` | close | todo |
| `get_history` | `session.tree` (previews only, not full messages) | real translation needed | todo |
| `rewind` | `session.rewind` | `message_index` vs `entryId` shape differs | todo |

## Streaming events (jcode `ApiEvent` → freecode `StreamEvent`)

| jcode_sdk | freecode | Shape | Status |
|---|---|---|---|
| `TextDelta`/`TextReplace`/`TextDone` | `text_delta` / `text` | jcode replaces-by-message_id; freecode is pure delta+final — translation logic needed | todo |
| `ReasoningDelta`/`ReasoningDone` | `thinking_delta` / `thinking` | close | todo |
| `ToolStart`/`ToolInputDelta`/`ToolExec`/`ToolDone` | `tool_start`/`tool_output`/`tool_complete` | freecode has no `ToolInputDelta` equivalent — drop or batch | todo |
| `TokenUsage` | `usage_totals` | field rename only | todo |
| `TurnDone`/`TurnStopped` | `done` | `stop_reason`/`stop_message` have no direct freecode fields | todo |
| `PermissionRequest` | `permission_asked` | close | todo |
| `Error` | `error` / `session.error` | close | todo |
| `MessageAccepted` | — | no equivalent — freecode's `session.send` just resolves; drop this wait-for-accept pattern in the shim | cut |
| `Compacted` | `compaction_complete` | close | todo |
| `SessionRenamed` | — | **gap** | todo — tied to `rename_session` decision above |

## No freecode equivalent — explicit scope decision required (Phase 5 of parent plan)

Each of these needs one of: stub to a clean "unsupported" error, hide the
UI affordance, or (rare) add new freecode IPC to support it. Default
assumption until decided: **cut for v1**.

| jcode_sdk surface | What it does | Status |
|---|---|---|
| `connect_ssh`/`SharedSshTransport`/`shared_ssh_transport` | SSH remote machines | cut |
| `global_events`/`GlobalEventStream`/`GlobalEventsOptions` | fan-in across all sessions, background discovery | cut |
| `launch`/`LaunchOptions`/`LaunchedInstance`/`ensure_runtime` | jcode's self-managed daemon launch/instance ownership | cut |
| `set_api_key`/`clear_api_key`/`notify_auth_changed`/`invalidate_usage` | OAuth-reload, usage-reset invalidation (partial overlap: freecode has `config.setApiKey`) | todo — partial |
| `configure_tools`/`list_tools`/`submit_tool_result`/custom `ToolCall` event | client-supplied custom tools | cut — freecode's tool system is entirely server-side |
| `applet_action`/`close_applet` | jcode's agent-applet UI primitive | cut |
| `todo_state`/`ack_todo_follow_up` | freecode has `TodoItem`/`todowrite` internally but no IPC exposing it to a frontend | todo — needs new IPC method if wanted |
| `background_tool`/`background_tool_result` | freecode's background shells (`shells.*`) are a different model (named shells, not move-current-call-to-background) | cut — or UI adapts to freecode's shell model |
| `runtime_command`/`get_runtime_info` | closest is `config.get`/`context.stats`, not a real match | cut |
| `read_file`/`find_files`/`search_text`/`file_status` | freecode's `read`/`glob`/`grep` are agent tools, not IPC methods a frontend calls directly | todo — add IPC methods, or route through `tools.call` |
| `soft_interrupt*`/`cancel_soft_interrupt*` | related to freecode's steering (`streamingBehavior: "steer"`) but not the same shape (queued+cancelable-by-id vs fire-and-forget) | todo — translation, not a gap |

## How to use this doc

- Before writing the shim crate (Phase 2+), walk this table top to bottom and flip `todo` → `stub` as each method gets a `todo!()` placeholder with the right signature.
- When actually implementing a method, flip `stub` → `done`.
- If a `cut` row turns out to matter, flip it back to `todo` and note why in this doc, not just in a commit message — the row is the tracking unit.
- Keep this doc in sync with the parent plan in CLAUDE.md's "Desktop App" section; that section should stay a short pointer here, not duplicate the table.
