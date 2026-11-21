# vendor/

Third-party source the desktop app (`apps/desktop`, "Honey") builds from,
committed here so a build never fetches it from Jeremy Huang's GitHub. Each
directory keeps its upstream licence files — keep them; MIT and Apache-2.0
both require the notice to ship with copies of the code.

| Directory | Upstream | Pinned at (`REV`) | What it is |
| --- | --- | --- | --- |
| `jcode/` | `github.com/1jehuang/jcode` | `jcode/REV` | MIT. The 45 jcode crates the desktop links (everything except `jcode-sdk`, which is our shim in `apps/desktop-shim/jcode-sdk`), plus `docs/kagi-web-search.md`, which `jcode-base` includes. |
| `handterm/` | `github.com/1jehuang/handterm` | `handterm/REV` | `handterm-common` only (the terminal engine). Its `workspace = true` dependencies are written out with the versions handterm's workspace pinned. MIT. |
| `gpui/` | `github.com/1jehuang/gpui` (a fork of Zed's GPUI, see `gpui/UPSTREAM`) | `gpui/REV` | The UI framework: its workspace manifest, every member crate (the workspace lists them all), `tooling/perf`, and `assets/fonts`, which `gpui` includes. Apache-2.0, © Zed Industries (`LICENSE`, `LICENSE-APACHE`). |
| `mermaid-rs-renderer/` | `github.com/1jehuang/mermaid-rs-renderer` | `mermaid-rs-renderer/REV` | Mermaid diagram rendering: manifest, `src`, and `benches` (the manifest declares a bench, so its file must exist). MIT. |

Not edited: these are upstream's files byte for byte, except
`handterm/handterm-common/Cargo.toml` (workspace inheritance inlined) and the
Google OAuth clients upstream embeds in `jcode-base/src/auth/gemini.rs` and
`antigravity.rs` (Gemini CLI's and Antigravity's), blanked to `""` — GitHub
push protection rejects them, and freecode core owns login. Re-blank them
after `scripts/vendor-jcode.sh`. Fix
behaviour in the shim or the desktop crates instead, so a refresh stays a copy.

- `scripts/desktop-overlay.sh` links `vendor/jcode/crates/*` into
  `apps/jcode/crates/`, where `apps/desktop`'s path dependencies resolve.
  `JCODE_UPSTREAM=/path/to/jcode` uses a full checkout instead (local work
  against a newer upstream only — releases build from here).
- **Refreshing jcode:** `bash scripts/vendor-jcode.sh /path/to/jcode` re-copies
  the vendored crates at that checkout's commit and updates both `REV` files.
  A crate a newer desktop needs: `mkdir vendor/jcode/crates/<name>` first.
- **Refreshing the others:** copy the same files from a checkout at the new
  commit, update `REV`, and bump nothing else — `apps/desktop/Cargo.toml`
  depends on them by path.
