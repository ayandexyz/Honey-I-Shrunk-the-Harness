# Omarchy Theme Feature

## Overview

The desktop app detects when it's running on an Omarchy system and keeps its
own theme synchronized with Omarchy's active system theme — the way Chrome,
VS Code, and terminal emulators already do on Omarchy. This includes a theme
switch reaching the app live, without a restart.

## What It Does

1. **Automatic Detection** — `omarchy::detected()` checks the `OMARCHY_PATH`
   env var, falling back to `DESKTOP_SESSION=omarchy`.
2. **Auto-Selection** — On startup, if Omarchy is detected, the "Omarchy
   System" theme preset is selected automatically (overriding the user's
   saved `config.appearance.theme` preference, since Omarchy's own theme is
   the stronger signal of intent on that platform).
3. **Full Color Derivation** — Omarchy's `pi.json` colors are built into a
   complete `Palette` and run through the same derivation every built-in
   theme uses (`palettes::Palette::theme()`), so every semantic role in the
   `Theme` struct is populated from Omarchy's palette — not just a hand-picked
   subset. An earlier version only mapped ~25 of the struct's ~58 color
   fields onto a `pure_black()` base, so anything it didn't explicitly set
   (`INPUT_BG`, `TOOL_BG`, `INLINE_CODE_BG`, `CURSOR`, `MINIMAP_*`,
   `USER_ACCENT`, `AI_ACCENT`, …) stayed pinned to near-black regardless of
   the active Omarchy palette. Fixed 2026-11-02.
4. **Contrast Safety Net** — Omarchy themes are arbitrary user files, not
   hand-tuned like the built-in palettes, so they aren't guaranteed to clear
   this app's AA contrast bar (`theme::tests` enforce 4.5:1 for every
   preset, this one included). `ensure_pane_step` and
   `readable_code_color`/`legible_with_margin` nudge only the roles that are
   actually tested as foreground text/icons toward the readable end, against
   the exact backgrounds they're tested against — a no-op when a theme
   already passes.
5. **Live Theme Sync** — Switching Omarchy's system theme (or hand-editing
   `pi.json`) is picked up within about a second, no restart required. See
   "Live Reload" below.
6. **Smart Fallback** — If Omarchy isn't detected, `pi.json` is missing, or
   it fails to parse, the preset falls back to the Pure Black palette.

## Architecture

### `apps/desktop/crates/jcode-desktop-ui-core/src/omarchy_theme.rs`

- `OmarchyThemeFile` — deserializes `pi.json`'s raw `vars`/`colors`/`export`.
- `OmarchyTheme` — the 25 semantic colors pulled out of those vars
  (background, foreground, accent, panel/header/border variants, status
  colors, a handful of syntax roles). `OmarchyTheme::load()` reads
  `~/.local/state/omarchy/current/theme/pi.json`; `theme_path()` resolves
  the path without reading it, used by the live-reload check.
- `ThemeWatcher` — a background-thread, 500ms-polling file watcher. It is
  defined and unit-tested but **not currently instantiated anywhere**; the
  actual live-reload path (below) is a different, lighter-weight mechanism
  that reuses the app's existing housekeeping loop instead of a dedicated
  thread. Left in place since it's self-contained and harmless, not because
  it's wired up — don't assume theme live-reload goes through it.

### `apps/desktop/crates/jcode-desktop-ui-core/src/theme.rs`

- `ThemePreset::OmarchySystem` — 19th preset (`"omarchy-system"` /
  `"Omarchy System"`, index 18).
- `omarchy_system_theme()` — builds a `palettes::Palette` from Omarchy's
  colors (with the contrast-safety nudges described above applied to the
  inputs before derivation, so every field that reuses e.g. "accent"
  inherits the fix), derives a full `Theme` via `.theme()`, then layers a
  few explicit pi.json values on top where they're more specific than the
  generic derivation (`ACCENT_DIM`, `SELECTION`, `ERROR_BG`, `CODE_BG`,
  `CODE_BORDER`). Falls back to `palettes::pure_black()` if `pi.json` can't
  be loaded.
- `ensure_pane_step()` — nudges the "raised" chrome color away from "panel"
  if Omarchy's `panel`/`panelAlt` are too close to distinguish focused vs.
  unfocused panes.
- `readable_code_color()` (in `palettes.rs`, made `pub(super)`) and
  `legible_with_margin()` — contrast-boost a foreground color against a
  background, reusing the same binary-search technique `apply_code_colors`
  already uses for syntax highlighting. `legible_with_margin` exists because
  one tested background is self-referential (it blends 5% of the very color
  being fixed back into itself), where solving exactly at the 4.5 threshold
  leaves a result that drifts back under it; a small margin absorbs that.
- `OMARCHY_LIVE` (`AtomicPtr<Theme>`) + `refresh_omarchy_theme_if_changed()`
  — the live-reload cache. See below.
- `Theme::global()` / `selected()` / `preview()` — read from the live cache
  instead of the frozen startup snapshot whenever the active (or previewed)
  preset is `OmarchySystem`.

### `apps/desktop/crates/jcode-desktop-ui/src/workspace.rs`

- The existing 1-second `housekeeping_task` loop (the same one that already
  polls for update/account state) now also calls
  `theme::refresh_omarchy_theme_if_changed()` when `omarchy::detected()`,
  and `cx.notify()`s the workspace if it changed — the identical redraw path
  the manual theme picker (`select_theme`) already uses.

### `apps/desktop/crates/jcode-desktop-ui-core/Cargo.toml`

- `serde_json` — parses `pi.json`.
- `dirs` — resolves `~` for the theme file path.

## Live Reload

```
Every 1s (workspace housekeeping loop, gated on omarchy::detected()):
  refresh_omarchy_theme_if_changed()
    stat(pi.json) — cheap, no parse
    mtime unchanged? → return false, nothing else happens
    mtime changed?   → rebuild Theme from pi.json, swap into OMARCHY_LIVE
                        (AtomicPtr), return true
  → true: workspace cx.notify()s, next frame renders the new colors
```

`OMARCHY_LIVE` intentionally leaks each previous `Theme` on swap rather than
freeing it: GPUI reads `Theme::global()` from many places with no obvious
lifetime to hang a lock or refcount off, and theme switches are a rare,
human-triggered event, not a hot path — a bounded leak is a better trade
than an unsound free or cloning the ~60-field `Theme` struct out of every
accessor (which is called very frequently per frame).

## Color Mapping

Full field-by-field mapping lives in `omarchy_system_theme()` (see above);
the short version, from `pi.json`'s `vars` to the derived `Theme`:

| Omarchy key              | Feeds (via `Palette`)                                  |
| ------------------------ | ------------------------------------------------------- |
| `background`              | `BG`, `CODE_BG` default                                 |
| `panel`                   | `PANEL_BG`, `MINIMAP_BG`                                |
| `panelAlt` (header_bg)    | `HEADER_BG`, `TOOL_BG`, `INLINE_CODE_BG`, `USER_BG`, `CODE_BG` (explicit) |
| `border`                  | `PANEL_BORDER`, `TOOL_BORDER`, `CODE_BORDER` default     |
| `foreground`              | `TEXT`, `TEXT_USER`, `HEADING`, `CODE_TEXT`              |
| `dimText`                 | `TEXT_DIM`, `TOOL_TEXT`, `REASONING`, `CODE_GUTTER`      |
| `mutedText`               | `TEXT_FAINT` (explicit)                                 |
| `accent`                  | `ACCENT`, `LINK`, `USER_ACCENT`, `PANEL_BORDER_FOCUS`, `CURSOR` |
| `accentDim`                | `ACCENT_DIM` (explicit)                                 |
| `color1`/`color2`/`color3` (error/success/warning) | `ERROR`, `OK`, `WARN` |
| `panelError`               | `ERROR_BG` (explicit)                                   |
| `selectedBackground`       | `SELECTION` (explicit)                                  |
| `color4` (code_type)       | `AI_ACCENT`                                              |

`CODE_KEYWORD`/`CODE_STRING`/`CODE_COMMENT`/`CODE_NUMBER`/`CODE_TYPE`/
`CODE_FUNCTION`/`CODE_VARIABLE`/`CODE_CONTROL`/`CODE_CONSTANT`/`CODE_TAG`/
`CODE_ATTRIBUTE` are deliberately **not** sourced from Omarchy: every preset
in `raw_themes()` runs through `apply_code_colors()` afterward, which
overwrites those fields uniformly from `CODE_BG`'s luminance (VS Code
Dark+/Light+ token colors, contrast-corrected). Setting them here would be
dead code.

## Fallback Behavior

- `OmarchyTheme::load()` fails (not on Omarchy, file missing, bad JSON) →
  the whole preset falls back to `palettes::pure_black()`.
- An individual `pi.json` color value that isn't valid hex → parses to
  `0x000000` for that one field (`hex()`'s `unwrap_or(0)`), not a crash.
- No panic on any input; always degrades to something renderable.

## Testing

```bash
cd apps/desktop
cargo test -p jcode-desktop-ui-core           # theme + omarchy_theme unit tests
cargo test -p jcode-desktop-ui --lib theme     # UI-level theme/picker tests
```

The `theme::tests` suite (in `theme.rs`, not `omarchy_theme.rs`) is the one
that actually exercises `omarchy_system_theme()` end-to-end against whatever
`pi.json` is live on the machine running the tests — including the AA
contrast assertions every preset must clear. `omarchy_theme.rs`'s own tests
cover the narrower pi.json-parsing/path-resolution logic in isolation.

## Scalability — adding more Omarchy-specific things

The pattern established here, for a future Omarchy integration beyond
theme (fonts, notification style, wallpaper-aware chrome, etc.):

1. A dedicated `omarchy_<thing>.rs` module (parallel to `omarchy_theme.rs`)
   that reads whatever Omarchy state file is relevant and exposes a small,
   semantic, fallback-safe struct — never raw pi.json/vars leaking past that
   module's boundary.
2. Gate activation on `omarchy::detected()` (`omarchy.rs`), so non-Omarchy
   systems pay zero cost beyond one env var check.
3. For anything that should update live: a cheap `refresh_if_changed()`
   function (mtime stat, only re-read/parse on change) called from the
   existing 1-second `housekeeping_task` loop in `workspace.rs`, `cx.notify`
   on change — do **not** spin up a new background thread per feature; the
   housekeeping loop already exists and this keeps the pattern consistent
   and cheap to extend. `ThemeWatcher`'s unused background-thread approach
   is the one pattern *not* to repeat.
4. Each addition needs its own wiring at these same three points — this
   isn't a generic "Omarchy plugin system," just a consistent, low-overhead
   shape to repeat per integration.

## Future Enhancements (Not Implemented)

- [ ] Watch `.local/state/omarchy/` via inotify instead of polling (would
      need the `notify` crate; 1s polling is already imperceptible for a
      theme switch, so this is a nice-to-have, not a gap).
- [ ] Sync Omarchy font preferences (currently hardcoded fonts).
- [ ] Export the desktop's theme back to Omarchy's format.
- [ ] Extend the pattern above to other Omarchy signals (see Scalability).

---

**Status:** Theme detection, full-palette derivation, contrast safety net,
and live reload are implemented and tested.
**Updated:** 2026-11-02
