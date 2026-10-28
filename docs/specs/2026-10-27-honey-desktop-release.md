# Honey desktop — release, distribution and updates

Status (2026-10-27): **R0, R1 and R2 done** — Linux packages build on a
`desktop-v*` tag and installed copies update themselves (proven beta.2 →
beta.3). See §6 for what exists. Rest of the doc is the plan. Companion to
`2026-10-26-jcode-sdk-shim-contract.md` (how the app works); this is how it
ships.

**2026-10-29 follow-up**: the shipped executable itself was renamed
`jcode-desktop` -> `honey-desktop` (package name in `apps/desktop/Cargo.toml`
stays `jcode-desktop`, via an explicit `[[bin]]`, for the reason item 5 in
§2.2 already gives for the version field: it conflicts on every upstream
subtree merge otherwise). This was previously deliberate — see the original
§2.2 item 8 and §6 R2 text below — because `archive.rs`'s `UNIX_FILES` is a
contract with every installed copy. Rationale for revisiting it: "Honey" had
already rebranded everything else a user or packager sees (download name,
launcher, icon, `.desktop` entry); the one file that still said
`jcode-desktop` was the compiled binary itself, which surprised a user
inspecting their own install. **Consequence**: any copy installed before this
change (running the old `jcode-desktop` binary, with the old `UNIX_FILES`
baked in) cannot self-update past it — the next release is the one single
exception that needs a manual reinstall, same mechanism as every other
`UNIX_FILES` change. Every release after that self-updates normally.
Touched: `Cargo.toml` (`[[bin]]`), `build.rs` (macOS link-arg-bin),
`managed.rs` (`EXECUTABLE`, launcher path), `release.rs`
(`Target::executable()`), `archive.rs` (`UNIX_FILES`/`WINDOWS_FILES`),
`lib.rs` and `updates.rs`/`updates/linux.rs` (`is_source_build` /
`source_executable` detection), `workspace_restart.rs`
(`is_desktop_process`'s `/proc/<pid>/exe` check), and
`scripts/package-honey-linux.sh`. Left unchanged, on purpose: the
`~/.local/opt/jcode-desktop` install-root directory name, the internal crate
names (`jcode-desktop-ui`, `jcode-desktop-updater`, …), and the upstream git
remote — none of those are the shipped binary.

Goal: a user downloads **Honey** (the `apps/desktop` GPU frontend running on
freecode core) from freecode.website, installs it in one step, and from then
on gets new versions automatically — the way Jcode Desktop ships from
jcode.sh, and the way freecode's CLI already ships.

---

## 1. How Jcode does it (researched 2026-10-27)

Sources: `apps/desktop/.github/workflows/*`, `apps/desktop/scripts/package-*`,
`crates/jcode-desktop-updater/`, https://jcode.sh/desktop,
https://jcode.sh/desktop/latest.json, https://jcode.sh/desktop/appcast.xml.

**What users see** (jcode.sh/desktop): one page, a download button per OS —
macOS universal `.dmg` (drag to Applications), Linux x86_64 `.deb` and
`.tar.gz` (arm64 too), Windows x86_64 portable `.zip` (unsigned, SmartScreen
warns). No install command for the desktop; the CLI has
`curl -fsSL https://jcode.sh/install | bash`. **The desktop bundles the
jcode runtime** — `package-linux.sh` puts `jcode` and
`jcode-harness-api-bridge` next to `jcode-desktop`, and the harness finds
them with `platform::companion_executable` (sibling of its own exe first).

**Pipeline** (all GitHub Actions):

| Step | Workflow | What it does |
|---|---|---|
| Decide | `auto-release.yml` | on push to main + hourly cron: coalesces commits, at most one release per `DESKTOP_RELEASE_INTERVAL_HOURS` (6), dispatches a tag `desktop-vX.Y.Z` |
| Build | `cross-platform-release.yml` (+ `macos-*.yml`, `freebsd-release.yml`) | on tag: creates a **private draft** release; matrix of native runners (ubuntu x86/arm, windows x86/arm, macOS); checks out **jcode at a pinned commit** next to the desktop; `cargo build --release`; `package-<os>.sh`; per-platform `SHA256SUMS-*`; uploads to the draft |
| Sign | `package-macos.sh` | `codesign` with Developer ID + `notarytool` + Sparkle framework; EdDSA-signs the update archive |
| Publish | `publish-public-release.yml` | downloads draft assets, writes `latest.json`, pushes them to a **separate public repo** (`1jehuang/jcode-desktop-releases`, token `JCODE_PUBLIC_RELEASE_TOKEN`), **re-downloads every asset anonymously and checks sha256 + size before promoting**, then publishes `appcast.xml` |
| Announce | `discord-release.yml` | posts release notes |

Secrets used: `APPLE_CERTIFICATE_P12/PASSWORD`, `APPLE_SIGNING_IDENTITY`,
`APPLE_API_KEY_ID/ISSUER_ID/KEY_P8` (notarization), `SPARKLE_PUBLIC_KEY` /
`SPARKLE_PRIVATE_KEY`, `JCODE_PUBLIC_RELEASE_TOKEN`, `DISCORD_RELEASE_WEBHOOK`.

**Updates** — two mechanisms, both already in the code we vendored:
- **Linux / Windows / FreeBSD**: `jcode-desktop-updater`. Checks
  `<PUBLIC_RELEASES>/desktop-latest/latest.json` (`tag_name: desktop-vX.Y.Z`,
  semver compare), downloads the asset for its `Target` (OS + arch),
  verifies it against `SHA256SUMS-<platform>`, and swaps it in: portable
  installs in place; a "managed" per-user install under
  `~/.local/opt/jcode-desktop` with an atomically switched
  `~/.local/bin/jcode-desktop` symlink; a root-owned `.deb` install adopts a
  managed per-user copy on its first update. Shared by the background check,
  `/update`, and headless `jcode-desktop --update`.
- **macOS**: Sparkle, reading `SUFeedURL` = `https://jcode.sh/desktop/appcast.xml`
  (items carry `sparkle:edSignature`), verified with `SUPublicEDKey`.

`latest.json` today: `desktop-v0.6.5`, 16 assets, each with name, size,
sha256 and a `jcode.sh/desktop/releases/<tag>/<file>` URL.

---

## 2. What Honey reuses, and what has to change

Most of the machinery exists in `apps/desktop` already. The changes are
small but every one is needed.

### 2.1 Things that stop a release from working at all

1. **The overlay needs a jcode checkout.** `apps/desktop` path-depends on
   ~9 jcode crates via `apps/jcode` (`scripts/desktop-overlay.sh`), which
   links to each developer's own checkout. CI has none. Pin it like Jcode
   does (`ref: 217c196…` in their workflow): a committed
   `apps/desktop-shim/JCODE_REV` file, CI checks out `1jehuang/jcode` at that
   commit into `apps/jcode-upstream`, then runs the overlay. Bump it on
   purpose, together with `pnpm desktop:sync`.
2. **Bundle freecode core next to the app.** Ship the `freecode` binary
   from `pnpm build:bun` (self-contained, bakes `FREECODE_BUNDLED=1`) beside
   `jcode-desktop` in every package, exactly as Jcode ships `jcode`. Then
   **`locate_core` in `apps/desktop-shim/jcode-sdk/src/freecode.rs` must look
   next to its own executable first** (after `FREECODE_CORE`). Today it tries
   `FREECODE_CORE` → monorepo `apps/core/dist` → `freecode` on PATH, which
   would pick an old global `freecode` over the bundled one. One version of
   Honey = one exact core, upgraded together.
3. **The packaged app must set its own env.** `JCODE_HOME` (keep Jcode's
   on-disk state out) and `JCODE_NO_TELEMETRY=1` are set by
   `scripts/desktop.sh` today; a double-clicked app never runs that. Set
   them as defaults at the very top of `src/main.rs` before any thread
   starts (only when unset) — a 5-line freecode hook in an upstream file,
   documented next to the others.
4. **Workflows must live in the repo root.** GitHub runs only
   `/.github/workflows`; `apps/desktop/.github/workflows` (Jcode's) is inert
   here. Honey's pipeline is new files under `/.github/workflows/`.

### 2.2 Identity and naming

5. **Version.** `apps/desktop/Cargo.toml` says `0.6.5` — Jcode's. Do not
   edit it (conflicts on every upstream bump): the build already accepts
   `JCODE_DESKTOP_VERSION` (`crates/jcode-desktop-ui/build.rs`), so CI passes
   Honey's own version, e.g. `0.1.0`, taken from the tag.
6. **Tags.** Keep the updater's `desktop-v<semver>` tag format (its parser
   requires it) — `desktop-v0.1.0`. freecode CLI tags stay `v*`, so the two
   release lines never collide.
7. **Feed URLs** (one-line edits each):
   `PUBLIC_RELEASES` in `crates/jcode-desktop-updater/src/release.rs`
   (→ Honey's public releases), `UPDATE_FEED_URL` in
   `scripts/package-macos.sh` (→ Honey's appcast), reinstall hint URL in
   `portable.rs` (`jcode.sh/desktop` → freecode.website/desktop).
8. **Asset names.** The updater and package scripts name files
   `Jcode-<version>-<os>-<arch>.<ext>` (the rebrand script skips them on
   purpose — they are matched, not displayed). Rename to `Honey-…` in the
   package scripts **and** the updater's `Target` patterns together, or users
   download a file called "Jcode". *(Done — see §6.)* The archive's inner
   executable name was a separate, later call: kept as `jcode-desktop` here
   deliberately (an update-contract filename, not user-facing), then renamed
   to `honey-desktop` on 2026-10-29 — see the follow-up note at the top of
   this doc.
9. **Icon** — `apps/web2/public/logoText.png` (1254×1254, square, opaque
   white background) → `apps/desktop/assets/app-icon/icon-1024.png`
   (`magick logoText.png -resize 1024x1024 icon-1024.png`); replaces the
   `logo2.png` version used now. Also feeds the macOS `.icns` and the
   Linux `.desktop` icon in packages.
10. **Bundle id.** macOS `CFBundleIdentifier` is
    `dev.solosystems.jcode.desktop` (Jcode's domain). Pick one you control,
    e.g. `website.freecode.honey`, before the first macOS release — changing
    it later orphans users' settings and breaks Sparkle continuity.

### 2.3 Signing and accounts

| Platform | Needed | Cost | Without it |
|---|---|---|---|
| Linux | nothing | — | works; `.deb` is just "unsigned" like Jcode's |
| Windows | optional code-signing cert | ~$100–400/yr | SmartScreen "unrecognized app" prompt (Jcode ships unsigned too) |
| macOS | Apple Developer ID + notarization | $99/yr | Gatekeeper blocks the app ("damaged/unidentified developer"); auto-update via Sparkle still needs its own EdDSA key |
| Updates (all) | Sparkle EdDSA keypair (`generate_keys`) | free | macOS updates cannot be verified |

---

## 3. The Honey pipeline

Same shape as Jcode's, sized for one maintainer.

```
tag desktop-v0.1.0 ──▶ desktop-release.yml
  ├─ prepare: create DRAFT release on ayandexyz/Honey-I-Shrunk-the-Harness
  ├─ build (matrix, native runners):
  │    linux-x86_64 (ubuntu-24.04) · linux-aarch64 (ubuntu-24.04-arm)
  │    macos-universal (macos-14) · windows-x86_64 (windows-2025)
  │    1. checkout repo + jcode @ apps/desktop-shim/JCODE_REV
  │    2. pnpm install; pnpm build:bun --target <os-arch>  → freecode core
  │    3. scripts/desktop-overlay.sh; cargo build --release -p jcode-desktop
  │       with JCODE_DESKTOP_VERSION=<tag version>
  │    4. package: Honey-<v>-linux-<arch>.tar.gz + .deb · Honey-<v>-macOS.dmg/.zip
  │       (sign + notarize + Sparkle-sign) · Honey-<v>-windows-x86_64.zip
  │       each containing jcode-desktop + freecode (+ ripgrep/onnx libs core needs)
  │    5. smoke: launch with --version / headless check; SHA256SUMS-<platform>
  │    6. upload to the draft
  └─ publish:
       write latest.json + appcast.xml; un-draft; upload latest.json to the
       fixed `desktop-latest` release (the updater's URL); re-download every
       asset anonymously and verify sha256 + size; only then announce
```

Start smaller than Jcode: no hourly auto-release coordinator (tag by hand),
no separate public mirror repo (your repo is already public), no FreeBSD /
Windows-arm. Add them when a real need appears.

**Where users download** — freecode.website (Astro, `apps/web2`):
- `/desktop` page: one button per OS, filled from `latest.json` at build
  time, plus checksums; `logoText.png` as the hero.
- Optional one-liner for Linux/macOS: `curl -fsSL https://freecode.website/install-desktop | bash`
  — downloads the right archive, verifies its checksum, installs the
  updater's "managed" layout (`~/.local/opt/…` + symlink + `.desktop` entry,
  like `scripts/desktop-install-launcher.sh` does for dev). Re-running it
  updates.

**How upgrades reach users**
- Linux / Windows: the built-in updater (background check, update chip,
  `/update`) — already in the app, only the feed URL changes.
- macOS: Sparkle — built in, needs the appcast + keys.
- Core upgrades ride along: it is inside the package.
- Rule from Jcode worth copying: **never promote a release before every
  asset re-downloads with the right checksum** — a half-published release
  would break every updater at once.

---

## 4. Order of work

| # | Milestone | Gets you |
|---|---|---|
| R0 | Prereqs: Phase 7 smoke test passes; merge `phase-2-desktop` → `main`; items 1–3, 5 above | an app that runs packaged, off a dev machine |
| R1 | Linux x86_64 `.tar.gz` + `.deb`, built by CI on a tag, manual download from GitHub Releases | first real users (you, on Omarchy) |
| R2 | `latest.json` + `desktop-latest` + updater feed URL + asset rename (items 6–8) | **automatic updates** on Linux |
| R3 | freecode.website `/desktop` page + `install-desktop` script + icon (item 9) | the "download Honey" experience |
| R4 | macOS: Developer ID, notarization, Sparkle keys, bundle id (item 10) | Mac users without Gatekeeper fights |
| R5 | Windows zip (unsigned first), linux-aarch64 | everyone else |
| R6 | optional: auto-release coordinator, release-notes generation, Discord/X post | Jcode-level automation |

Each step is testable on its own: R1 by installing the `.deb` on a clean
user; R2 by publishing `desktop-v0.1.1` and watching a `0.1.0` install update
itself (Jcode has `scripts/e2e-update.py` and `accept-linux-update.py` to
borrow from).

## 5. Open decisions

- Version line: start Honey at `0.1.0`, independent of freecode CLI's
  `0.47.x`? (recommended — they release at different speeds).
- Download host: GitHub Releases URLs directly, or freecode.website
  redirects in front of them (Jcode serves `jcode.sh/desktop/releases/…`) —
  redirects let you move hosting later without breaking old updaters.
- macOS in R4 needs a paid Apple account; until then, ship Linux (+ Windows)
  only.

## 6. Built so far (2026-10-27)

**R0 code blockers**
1. `apps/desktop-shim/JCODE_REV` pins jcode `b09a8a5f` (public, `origin/master`,
   the checkout the shim was built and tested on). `desktop-overlay.sh`
   warns when the local checkout differs. `apps/desktop/Cargo.lock` is now
   **committed**, resolved against that pin, so release builds use
   `cargo build --locked`; `desktop:sync` restores it before a pull and a
   conflicting one is regenerated by building.
2. `locate_core` order is `FREECODE_CORE` → **`freecode` next to the
   executable** (`bundled_core`, unit-tested) → monorepo `apps/core/dist` →
   PATH.
3. `apply_freecode_env()` at the top of `apps/desktop/src/main.rs` sets
   `JCODE_HOME` (`FREECODE_DESKTOP_JCODE_HOME` or
   `~/.freecode/desktop/jcode-home`) and `JCODE_NO_TELEMETRY=1` for every
   launch; `scripts/desktop.sh` no longer sets them. Verified: the binary
   launched directly with neither variable loads 0 Jcode sessions and sends
   no telemetry.
5. `JCODE_DESKTOP_VERSION=0.1.0` → `--version` prints `Honey Desktop v0.1.0`.
9. Icon is `apps/web2/public/logoText.png` (1024×1024).

**R1 Linux packaging**
- `scripts/package-honey-linux.sh <version> [--profile release|dev]`: builds
  core (`build-bun.mjs`, + ripgrep 15.2.0 + onnxruntime libs) and the desktop
  (`--locked`, `JCODE_DESKTOP_VERSION`), stages
  `jcode-desktop`, `freecode`, `rg`, `libonnxruntime*`, a `honey` symlink,
  `honey.desktop`, `honey.png`; checks `--version` before archiving; writes
  `Honey-<v>-linux-<arch>.tar.gz`, `Honey-<v>-linux-<debarch>.deb` (files in
  `/usr/lib/honey`, `/usr/bin/honey` symlink; needs `dpkg-deb`, so CI
  only) and `SHA256SUMS-linux[-aarch64]`. Verified locally (dev profile):
  109 MB tarball, checksum OK, extracted outside the repo and run with
  `env -i` (no `freecode` on PATH) → it spawned **its own bundled**
  `freecode serve`, listed freecode's sessions, and left no process behind.
- `.github/workflows/desktop-release.yml`: tag `desktop-v<semver>` → draft
  release (`--latest=false`) → linux x86_64 + aarch64 matrix (pinned jcode
  checkout, pnpm, bun, Rust, apt deps, packaging script, artifacts, upload to
  the draft) → publish job re-downloads every asset, checks every
  `SHA256SUMS-*`, then un-drafts, still `--latest=false` so the CLI's
  `install.sh` and TUI update check keep reading the CLI release.
  `workflow_dispatch` builds artifacts only. **Not yet run on GitHub.**

**Fixes after the first CI run (`desktop-v0.1.0-beta.1`, 13½ min, passed)**
- It printed `v0.1.0-beta.1 (3b7306c, dirty)`: `pnpm-lock.yaml` still listed
  the deleted `apps/web-app` (984 lines), so `pnpm install` rewrote it and
  the build saw a modified tree. Lockfile regenerated; the workflow installs
  with `--frozen-lockfile` so a stale lockfile fails instead. "Dirty" only
  ever affected the label — `development` is `explicit version is None`
  (`build_version.rs`), and CI always passes one.
- `-beta` versions are now created as GitHub pre-releases.

**R2 auto-update (built and proven)**
- The updater validates an archive against a **fixed file list compiled
  into the installed copy** (`archive.rs` `UNIX_FILES`), so the list is a
  contract: an archive with any other file is rejected forever by older
  installs. Honey's Linux list, the same on every architecture (renamed
  2026-10-29, see the follow-up note at the top of this doc —
  `jcode-desktop` before that date):
  `honey-desktop`, `freecode`, `rg`, `honey` (a launcher *script* — the
  updater forbids links), `honey.desktop`, `honey.png`,
  `libonnxruntime.so.1`. The versioned `libonnxruntime.so.1.21.0` duplicate
  and the GPU-provider `libonnxruntime_providers_shared.so` (x86_64 only)
  are dropped; the bundled core still reports `embedder: available` with
  only `libonnxruntime.so.1` (load verified, not a full embedding run). An
  onnxruntime major bump that renames the soname would break this contract
  and needs a migration release.
- `package-honey-linux.sh` reads `UNIX_FILES` from the updater source and
  refuses to archive anything else.
- Updater edits (freecode hooks): `PUBLIC_RELEASES` → this repo's releases,
  archive/asset prefix `Honey-`, `UNIX_FILES` (7, first 4 executable),
  `files()` returns a slice (Windows keeps Jcode's 5 until R5), the
  reinstall hint URL; tests updated to count per target. 24/24 pass.
- Workflow publish: after the checksum check, writes
  `latest.json` = `{"tag_name":"desktop-v…"}`, uploads it to the fixed
  `desktop-latest` release (pre-release, never "latest"), and re-fetches it
  anonymously until it serves the new tag. One channel: betas reach every
  install.
- **Proven end to end 2026-10-27.** `desktop-v0.1.0-beta.2` (CI 16 min) was
  installed from its GitHub release into a fresh folder: checksum OK,
  `v0.1.0-beta.2 (3be9aa7)` (no "dirty"), exactly the 7 files, and
  `honey --update` said "up to date" against the feed. After
  `desktop-v0.1.0-beta.3` published (the same commit, re-tagged), that copy's
  `honey --update` printed "Downloading Honey Desktop 0.1.0-beta.3 …
  Installed … (portable)", `--version` became `v0.1.0-beta.3`, all 7 files
  were swapped, and the app then launched as beta.3 on its bundled core.
  The replaced files stay beside the new ones (`*.jcode-old-*`, for
  rollback) until the background updater's first pass, `FIRST_CHECK_DELAY`
  after launch; with `JCODE_DESKTOP_LIVE_UPDATE_TEST=1` (1 s) a launch
  removed all 7. Users also get the same check in the background every
  `CHECK_INTERVAL`, from the version pill, and from `/update`.
