import type { RgbColor, TUI } from "@earendil-works/pi-tui";

export type Scheme = "light" | "dark";

/** Light when the background's relative luminance is above the midpoint. */
export function schemeForBackground({ r, g, b }: RgbColor): Scheme {
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.5 ? "light" : "dark";
}

/**
 * Ask the terminal whether it is light or dark: the colour-scheme report
 * (`CSI ?996n`, Ghostty/kitty/Contour), else the background colour (OSC 11,
 * answered by most terminals including VS Code's). Undefined when neither
 * answers — the caller keeps the current palette. Never blocks startup: the
 * caller fires this after `tui.start()` and repaints when it settles.
 */
export async function detectTerminalScheme(
  tui: Pick<TUI, "queryTerminalColorScheme" | "queryTerminalBackgroundColor">,
  timeoutMs = 250,
): Promise<Scheme | undefined> {
  const reported = await tui.queryTerminalColorScheme({ timeoutMs });
  if (reported) return reported;
  const background = await tui.queryTerminalBackgroundColor({ timeoutMs });
  return background ? schemeForBackground(background) : undefined;
}
