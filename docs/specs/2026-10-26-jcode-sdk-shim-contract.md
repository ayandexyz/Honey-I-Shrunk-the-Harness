# jcode-sdk shim contract — apps/desktop backend

Full plan + contract for wiring `apps/desktop` to freecode's `apps/core`
instead of Jcode's real backend. CLAUDE.md/AGENTS.md's "Desktop App" section
is a short pointer to this doc, not a copy — this is where the detail (and
the per-item Status tracking) lives, kept out of the main agent guide so it
isn't reloaded every turn.

## Background

The native desktop frontend is vendored from
[jcode-desktop](https://github.com/1jehuang/jcode-desktop) (MIT) via `git
subtree` into `apps/desktop` — not a submodule or one-time copy, so it keeps
upstream's history and can pull upstream's future commits. It replaced the
old Tauri/React `apps/web-app` (retired, commit `21dc2260`), which also used
to be what `apps/core/web-server.ts` served to phones/browsers — that path
404s until this app (or something else) ships a replacement bundle.

Stack: Rust, not TypeScript — a GPU-accelerated native UI (`gpui`) across 9
workspace crates (`jcode-desktop-ui`, `-ui-core`, `-harness`, `-motion`,
`-voice`, `-accounts-ui`, `-api`, `-updater`, `-model`). Doesn't go through
`packages/shared` or the Node/bun toolchain — a fully separate build
(`cargo`, not `pnpm`).

## The real integration point — corrected 2026-10-26

An earlier note claimed only `crates/jcode-desktop-api` needed to diverge
from upstream. **That was wrong** — `jcode-desktop-api` turned out to be
unrelated window-launch plumbing. The actual coupling to Jcode's backend is
much deeper:

- Every desktop crate depends on **`jcode-sdk`** (~8,400 lines) and its own
  4 sub-crates (`jcode-harness-api`, `jcode-applet-types`,
  `jcode-provider-metadata`, `jcode-transport` — ~7,800 more lines
  combined), currently a **path dependency on a sibling `jcode` checkout**
  (`../../../jcode/crates/...` from each `Cargo.toml` — doesn't build
  standalone; needs a local `jcode` repo symlinked in, e.g. `apps/jcode` →
  a `githubprojects/jcode` checkout, gitignored, not committed).
- `jcode-desktop-harness` (~9,400 lines, `harness.rs` alone 4,084) directly
  orchestrates `jcode_sdk::JcodeClient` for session lifecycle, turn
  submission/retry, SSH remote transport, and managed-cloud provisioning.
- `jcode-desktop-ui` imports `jcode_sdk` types **directly in ~50 files**
  (`panel.rs`, `workspace.rs`, `sidebar_*.rs`, …) — not cleanly isolated
  behind the harness.

**Chosen approach — a drop-in `jcode-sdk` shim, not a UI rewrite.** Write a
new crate named `jcode-sdk` with `jcode_sdk::client.rs`'s same public types
and `JcodeClient` method signatures (`connect`, `create_session`, turn
submission, `EventStream`, `TurnResult`, …), but have its internals speak
freecode's JSON-RPC to `apps/core` (`packages/shared/src/ipc/protocol.ts` —
`METHODS`, `StreamEvent`) instead of Jcode's own socket protocol. If the
shim's surface matches closely enough, `jcode-desktop-harness` and the ~50
UI files need **no changes at all** — only what's underneath `JcodeClient`
changes. This is what keeps `git subtree pull` useful long-term: upstream
only ever touches UI/harness files we never modify, so pulls should stay
close to conflict-free. The *only* crate that's permanently "ours" and
never comes from upstream is this `jcode-sdk` shim.

## Phased plan

1. **Done 2026-10-26** — Read `jcode-sdk/src/client.rs` fully; map each
   method/event to freecode's `METHODS`/`StreamEvent`, flag gaps both
   directions. Produced the contract tables below.
2. Stub `jcode-sdk` shim crate (`[patch]`'d in over the path dep) with real
   signatures, `todo!()` bodies — gets the harness + UI compiling against it
   and surfaces exactly how leaky the abstraction really is before
   committing further.
3. Wire the transport: `JcodeClient::connect` spawns/attaches `apps/core`,
   speaks JSON-RPC over stdio (reuse freecode's existing protocol, not a new
   one).
4. Map session + turn methods (the bulk of the work — tool-call/event
   shapes will need renaming, not just passthrough).
5. Decide + implement the SSH/managed-cloud/accounts gap (stub vs. hide).
6. Fix UI fallout file by file.
7. Smoke test: real session, real streaming reply, through the GPU UI.

## Maintenance going forward

- **Pulling upstream updates**: `git subtree pull --prefix=apps/desktop
  jcode-desktop-upstream main -m "..."` (remote `jcode-desktop-upstream` →
  `https://github.com/1jehuang/jcode-desktop.git`, already added). Check
  `apps/desktop/CHANGELOG.md` first for anything that assumes Jcode's own
  runtime — that's where conflicts are expected, confined to the shim
  crate.
- **Pushing changes back upstream** (if ever wanted): `git subtree push
  --prefix=apps/desktop jcode-desktop-upstream <branch>`. Only UI/UX fixes
  that make sense outside this fork — never the shim crate.
- **Pulling an unmerged upstream PR** (done once already for PR #12): add
  the contributor's fork as a remote, `git subtree pull
  --prefix=apps/desktop <remote> <branch>`.
- **Don't rename/rebrand** the binary, bundle id, or window title away from
  "Jcode" casually — product decision, not a refactor; keep upstream's
  LICENSE/copyright notice regardless (MIT requires it).
- **Build + run**: `pnpm desktop` from the repo root (`scripts/desktop.sh`)
  — checks `apps/jcode` (the sibling-checkout symlink the path deps need;
  gitignored, machine-specific, script errors with setup instructions if
  missing), then `cargo run -p jcode-desktop` with `CARGO_BUILD_JOBS=1
  CARGO_PROFILE_DEV_DEBUG=0` by default (single-job, stripped debug info —
  a full parallel build crashed a 7.6GB-RAM machine; override either env
  var if your machine has more headroom). Opens its own GPU window
  directly.
- **Until the shim is built**, running the binary connects to **Jcode's
  real backend** (via the sibling `jcode` checkout), not freecode's
  `apps/core` — confirmed working 2026-10-26 (loaded local sessions,
  created a new one against Jcode's backend). Don't treat a working launch
  as proof freecode's backend is wired — it isn't yet.

## Contract tables

Tracks the exact surface the `jcode-sdk` shim crate needs to implement so
`apps/desktop`'s harness + UI compile and run unmodified against freecode's
`apps/core`. Edit this doc's **Status** column as work lands or scope
changes.

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
