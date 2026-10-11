# pi-tui features FreeCode doesn't use yet

**Date:** 2026-10-12 · **pi-tui:** `@earendil-works/pi-tui@0.80.10`

This compares everything pi-tui exports (`dist/index.d.ts`) with what
`apps/tui/src` imports. FreeCode already uses `Editor`, `Markdown`,
`SelectList`, `Input`, `Loader`, `Box`, overlays, keybindings, autocomplete,
`Image` (since `7d9c56e2`), `hyperlink` (clickable file paths in tool
headers) and `fuzzyFilter` (model/provider pickers, `/mcp`, `/tree`,
`/rewind`; the `/` command menu keeps its own ranking). Below are the parts
it doesn't use, in the order they're worth building.

| # | Feature | Effort | Verdict |
|---|---|---|---|
| 1 | Terminal light/dark detection | Medium | Worth doing |
| 2 | `SettingsList` | Medium, + one IPC method | Worth doing |
| 3 | `KeybindingsManager` / `setKeybindings` | Small–medium | Worth doing |
| 4 | `CancellableLoader` | — | Skip |
| 5 | `TruncatedText` | — | Skip |

---

## 1. Terminal light/dark detection

**What it is.** `TUI.onTerminalColorSchemeChange(listener)` +
`setTerminalColorSchemeNotifications(true)` (mode `?2031`), plus
`parseOsc11BackgroundColor` for a one-off read of the background colour
(OSC 11).

**Where it goes.** `palette.ts` takes its colours from the Omarchy theme. In
terminals that report a colour scheme, FreeCode could switch to its light or
dark palette when the system theme changes, instead of drawing dark-theme
colours on a light background.

**Watch for.** Many terminals never answer either query. Keep the current
theme when there's no reply, and never wait on one at startup.

## 2. `SettingsList`: a `/settings` panel

**What it is.** A list of settings, each with a label on the left and its
current value on the right. `values` makes Enter/Space cycle through choices,
`submenu` opens a nested component, and `enableSearch` filters the list.

**Where it goes.** A `/settings` panel for toggles that today can only be
changed in `settings.json` or with environment variables: memory
(`autoRecall`, `autoExtract`, `retrievalJudge`), `cache.warming`,
`checkpoints.enabled`, `tasks.notify`, and the `signals.*` gates.

**Watch for.** Frontends stay thin. The panel only shows values and sends
changes; core reads and writes the settings files. That needs a
`config.set` IPC method, since only `config.get` exists today. Loop gates that
are off by default should be labelled as experimental.

## 3. `KeybindingsManager` / `setKeybindings`: user keybindings

**What it is.** A keybinding registry that reports conflicts, with
`TUI_KEYBINDINGS` as the defaults.

**Where it goes.** A `~/.freecode/keybindings.json` that the TUI loads at
startup and passes to `setKeybindings`. Today the bindings are fixed in code,
and `getKeybindings()` is read by `menu-card.ts`,
`searchable-select-list.ts` and `prompt-editor.ts`.

**Watch for.** Report conflicts as a notice at startup instead of silently
letting one binding win.

## 4. `CancellableLoader`: skip

A spinner that Esc can cancel. FreeCode's own in-progress row
(`createInProgressMessage`) already shows token counts and context use and
handles Esc. Switching would remove features.

## 5. `TruncatedText`: skip

Single-line text cut to fit the width. `WidthBounded` and
`truncateToWidth` already do this throughout `message-row.ts`.

---

## Already handled by the `TUI` FreeCode runs on

- The Kitty keyboard protocol (`isKittyProtocolActive`, `isKeyRelease`) and
  `StdinBuffer`.
- Asking the terminal for its cell size (`CSI 16 t`), used to size images.

## Unfinished image work (from `7d9c56e2`)

- Images the `read` tool loads aren't shown. Core needs to put the image data
  into the `tool_complete` event, which today carries only the text receipt.
- Pasted images aren't redrawn in resumed sessions or on queued-prompt rows.
- Every scroll step while an image is cut off re-sends the whole image
  (`image-clip.ts`). If that's slow, the fix is to send the image once
  (`a=t`) and move it with placement commands (`a=p`). This also means pi-tui
  must not free the image data on every change (`deleteKittyImage` uses
  `d=I`).
