// Block-letter ASCII for the OMAR-style mark the TUI renders beside the
// portrait. Plain monochrome (no per-run color); the renderer paints each
// line through `palette.accent` (bright) and a theme-aware dim paint, so
// the live Omarchy theme switch repaints it for free.
//
// Source: user's verbatim paste — half-block `M` mark with three trailing
// blank rows that the renderer treats as a tail (kept on purpose so the
// block doesn't sit flush against the subtitle when vertically centered).
export const glyphLines: readonly string[] = [
  " █████   █████  ███           █████    █████      ███",
  "▒▒███   ▒▒███  ▒▒▒           ▒▒███    ▒▒███      ▒███",
  " ▒███    ▒███  ████   █████  ███████   ▒███████  ▒███",
  " ▒███████████ ▒▒███  ███▒▒  ▒▒▒███▒    ▒███▒▒███ ▒███",
  " ▒███▒▒▒▒▒███  ▒███ ▒▒█████   ▒███     ▒███ ▒███ ▒███",
  " ▒███    ▒███  ▒███  ▒▒▒▒███  ▒███ ███ ▒███ ▒███ ▒▒▒ ",
  " █████   █████ █████ ██████   ▒▒█████  ████ █████ ███",
  "▒▒▒▒▒   ▒▒▒▒▒ ▒▒▒▒▒ ▒▒▒▒▒▒     ▒▒▒▒▒  ▒▒▒▒ ▒▒▒▒▒ ▒▒▒ ",
  "",
  "",
  "",
];

/** The widest content line; the renderer pads everything else to this width. */
export const GLYPH_WIDTH = 55;
