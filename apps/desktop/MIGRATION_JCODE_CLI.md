# Desktop → freecode CLI migration checklist

`apps/desktop` was vendored from jcode-desktop and still shells out to a
companion `jcode` CLI binary in several places, independent of the GPUI/Rust
↔ JSON-RPC shim work tracked in
`docs/specs/2026-10-26-jcode-sdk-shim-contract.md`. This file tracks every
`jcode`-CLI-coupled spot so each can be rewired to `freecode` step by step.

## Done

- **Account status panel** — `crates/jcode-desktop-harness/src/accounts.rs`
  `fetch()`. Was `jcode auth status --json` + `jcode usage --json`, merged.
  Now calls `freecode auth status --json` only (`apps/core/src/cli/commands/auth.ts`
  `statusCommand`, added 2026-10-27). The `--json` output walks the whole
  models.dev catalogue via `resolveCatalogue()` and marks each provider
  `available`/`not_configured` via `hasApiKey()`, so a configured key shows as
  connected. The `usage --json` merge was dropped — freecode has no `usage`
  command yet, so quota/limit bars (`UsageLimit`, `BankedReset`, "Upgrade"
  offers) are gone from the account panel until one exists (see below).

## Not done — still calling `jcode`

- **`crates/jcode-desktop-accounts-ui/src/connection.rs`** (`fetch_connection_statuses`,
  `run_live_test`): calls `jcode auth doctor --json` and
  `jcode auth doctor <provider> --validate --json`. freecode has no `auth
  doctor` subcommand. Needed for the per-provider "Connected / Unverified /
  Failed" status and the "Test" button. Would need a new freecode command
  that does a live validation call per provider and reports
  `{providers:[{id, status, validation_result}]}`.

- **`crates/jcode-desktop-ui/src/panel_login.rs`** (`open_login_picker`):
  builds an `AuthClient` pointed at the `jcode` binary for the interactive
  login picker (OAuth/device-code flows inside the GPUI panel, not just status).
  freecode's OAuth login (`freecode auth login <provider>`) is a different
  shape (PKCE + localhost callback or paste), not the `AuthClient`'s protocol —
  needs its own look before swapping the binary name.

- **`crates/jcode-desktop-harness/src/harness.rs`** (`revive_local_runtime`,
  `start_local_runtime`): spawns `jcode` as the long-running backend daemon via
  `jcode_sdk::ensure_runtime`/`LaunchOptions`, and talks to it over
  `jcode_sdk::api::legacy_socket_path()` — this is the actual runtime process
  the whole desktop UI drives, not just account status. This is the core of
  the sdk-shim-contract work already tracked separately; don't duplicate that
  plan here, just note it's the big one.

- **`crates/jcode-desktop-ui/src/workspace_restart.rs`** (`reload_server`):
  runs `jcode server reload --force` for the UI's manual "reload server"
  action. freecode's equivalent is `apps/core/src/cli/commands/serve.ts` —
  check it exposes an equivalent `reload --force` before swapping.

- **Cosmetic / catalogue-only `"jcode"` references** (no rewiring needed,
  just a product-identity question): `jcode-desktop-accounts-ui/src/catalog.rs`,
  `jcode-desktop-harness/src/accounts.rs` (`id == "jcode"` subscription
  provider, `jcode.sh` upgrade links), `jcode-desktop-ui/src/{markdown,panel,
  input_model_menu,panel_composer,workspace,workspace_account_sign_in}.rs`.
  These treat `"jcode"` as a *provider id* (jcode's own hosted subscription
  plan, like `"openai"` or `"anthropic"` are provider ids), not the CLI
  binary — decide separately whether freecode offers an equivalent hosted
  plan or this provider entry should just be dropped.

## Still missing on the freecode CLI side

- `freecode usage --json` — per-provider rolling/limit usage, banked resets,
  upgrade links. Needed to restore quota bars in the account panel.
- `freecode auth doctor [provider] [--validate] --json` — live credential
  health check, optionally spending a real request to validate.
- Confirm `freecode server reload --force` (or equivalent) exists/matches
  `serve.ts`'s flags before wiring `workspace_restart.rs`.
