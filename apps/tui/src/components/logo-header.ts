import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import chalk, { Chalk } from "chalk";
import { GLYPH_WIDTH, glyphLines } from "../assets/glyph.js";
import { PORTRAIT_WIDTH, portraitLines } from "../assets/portrait.js";
import { getDisplayDirectory, getVersion } from "../utils/display.js";
import { palette } from "../palette.js";
import { omarchyPalette } from "../utils/omarchy-theme.js";

// The portrait carries its own truecolour per run, so paint it at level 3
// (same as palette.ts) rather than through the theme's accent pair.
const hex = new Chalk({ level: 3 });

const coloredLogoLines = portraitLines.map((runs) =>
  runs
    .map(([text, fg, bg]) => {
      let paint = (t: string) => t;
      if (fg) paint = hex.hex(fg);
      if (bg) {
        const fgPaint = paint;
        paint = (t) => hex.bgHex(bg)(fgPaint(t));
      }
      return paint(text);
    })
    .join(""),
);

// Block-letter ASCII painted to the right of the portrait. The bright half
// follows the theme's `accent`; the dim half stays `accentDim` on Omarchy
// and goes red off Omarchy, per the user's explicit override of the
// chalk-yellow fallback.
const dimHalf = omarchyPalette ? palette.accentDim : chalk.red;
const coloredGlyphLines = glyphLines.map((line) => {
  const mid = Math.floor(line.length / 2);
  return palette.accent(line.slice(0, mid)) + dimHalf(line.slice(mid));
});

/** Portrait + 1 space + glyph; the actual visible width of a side-by-side row. */
const COMBINED_WIDTH = PORTRAIT_WIDTH + 1 + GLYPH_WIDTH;

/** "-1" sentinel from the index.ts cache means "not loaded yet". */
const PENDING = "…";

/**
 * Pinned top-of-TUI logo header. Renders the Omarchy-style ASCII portrait
 * logo (truecolour) on the left and the half-block ASCII mark on the
 * right, both centered horizontally in the terminal, with the
 * `>_ Histh! (vX.Y.Z)` subtitle, a compact stats line (tools/MCP/skills/
 * plugins counts) and a directory line below — also centered. When the
 * caller passes a `height` ≥ the block's own row count, the whole thing
 * is vertically centered in the terminal.
 *
 * The counts come from accessor functions so the parent can cache them
 * once at startup and the header stays synchronous.
 */
export class LogoHeader implements Component {
  /**
   * Rendered every frame as the message list's first entry (even in follow
   * mode, where the window slice usually discards it), so the lines are
   * cached on everything they actually depend on: width, height, the
   * counts, and the Omarchy accent (so a live theme switch repaints the
   * half-block mark).
   */
  private cache?: {
    width: number;
    height: number;
    tools: number;
    mcp: number;
    skills: number;
    plugins: number;
    update: string | null;
    /** Omarchy source palette; `null` off Omarchy. Bump so a live theme switch
     *  invalidates the cached glyph paint without invalidating the rest. */
    themeFingerprint: string | null;
    lines: string[];
  };

  constructor(
    private getToolCount: () => number,
    private getMcpCount: () => number,
    private getSkillCount: () => number,
    private getPluginCount: () => number,
    // The newer release's version once the background probe answers, null
    // while it is in flight and for good after it comes back empty. Same
    // accessor shape as the counts so the header stays synchronous.
    private getUpdateVersion: () => string | null = () => null,
  ) {}

  invalidate(): void {
    this.cache = undefined;
  }

  /**
   * Center a styled fragment by padding with spaces. `visiblePlainLen` is the
   * width of the *plain* (ANSI-stripped) text — needed because chalk adds
   * escape codes that mis-align a naive `.length` measurement.
   */
  private centerLine(width: number, visiblePlainLen: number, styled: string): string {
    const padLeft = Math.max(0, Math.floor((width - visiblePlainLen) / 2));
    const padRight = Math.max(0, width - visiblePlainLen - padLeft);
    return " ".repeat(padLeft) + styled + " ".repeat(padRight);
  }

  private formatCount(n: number): string {
    return n < 0 ? PENDING : String(n);
  }

  render(width: number, height: number = 0): string[] {
    if (width < COMBINED_WIDTH) {
      // Too narrow for the side-by-side layout; skip the overlay rather than
      // truncating it.
      return [];
    }

    const toolCount = this.getToolCount();
    const mcpCount = this.getMcpCount();
    const skillCount = this.getSkillCount();
    const pluginCount = this.getPluginCount();
    const updateVersion = this.getUpdateVersion();
    // `accent` is the single key the glyph's bright half reads, and the dim
    // half only branches on Omarchy's existence; that's all the fingerprint
    // needs to invalidate a cached render when the theme flips.
    const themeFingerprint = omarchyPalette ? omarchyPalette.accent : null;
    if (
      this.cache &&
      this.cache.width === width &&
      this.cache.height === height &&
      this.cache.tools === toolCount &&
      this.cache.mcp === mcpCount &&
      this.cache.skills === skillCount &&
      this.cache.plugins === pluginCount &&
      this.cache.update === updateVersion &&
      this.cache.themeFingerprint === themeFingerprint
    ) {
      return this.cache.lines;
    }

    const padLeft = Math.max(0, Math.floor((width - COMBINED_WIDTH) / 2));
    const padRight = Math.max(0, width - COMBINED_WIDTH - padLeft);
    const indent = " ".repeat(padLeft);
    const rightPad = " ".repeat(padRight);

    // Subtitle: `>_ Histh! (vX.Y.Z)` — plain + styled built separately so the
    // centered pad math matches the visible width.
    const version = getVersion();
    const subtitlePlain = `>_ Histh! (v${version})`;
    const subtitleStyled =
      `>_ ${chalk.bold(palette.accent("Histh!"))} ` +
      chalk.dim(`(v${version})`);
    const subtitleLine = this.centerLine(width, subtitlePlain.length, subtitleStyled);

    // Sits directly under the subtitle, and only once the background probe
    // has found a newer release — nothing is installed on our initiative any
    // more, so this line is the whole of the update story the user sees.
    const updateLines: string[] = [];
    if (updateVersion) {
      const updatePlain = `update available (v${updateVersion}) · run freecode update`;
      const updateStyled =
        palette.accent("update available") +
        chalk.dim(` (v${updateVersion}) · run `) +
        chalk.bold("freecode update");
      updateLines.push(this.centerLine(width, updatePlain.length, updateStyled));
    }

    // Stats: `Tools: N    MCP: M    Skills: K    Plugins: P` — dimmed
    // labels, plain values, four spaces between pairs.
    const stats: Array<[string, number]> = [
      ["Tools", toolCount],
      ["MCP", mcpCount],
      ["Skills", skillCount],
      ["Plugins", pluginCount],
    ];
    const statsPlain = stats
      .map(([label, n]) => `${label}: ${this.formatCount(n)}`)
      .join("    ");
    const statsStyled = stats
      .map(([label, n]) => chalk.dim(`${label}:`) + ` ${this.formatCount(n)}`)
      .join("    ");
    const statsLine = this.centerLine(width, statsPlain.length, statsStyled);

    // Directory: `Directory: <cwd>` — dimmed label, plain path.
    const cwd = getDisplayDirectory();
    const dirPlain = `Directory: ${cwd}`;
    const dirStyled = chalk.dim("Directory:") + ` ${cwd}`;
    const dirLine = this.centerLine(width, dirPlain.length, dirStyled);

    // Side-by-side: portrait on the left, half-block ASCII mark on the
    // right. The portrait is taller than the glyph's content rows; trailing
    // empty rows in `glyphLines` keep the subtitle from crowding the mark.
    // The styled glyph is built from each plain line individually, so its
    // visible width is `glyphPlain.length`; we pad the **visible** tail
    // out to `GLYPH_WIDTH` so the right edge of the row lines up with
    // every other row regardless of which glyph line is in play. Without
    // that, a short glyph row (trailing blanks, narrow tops) leaves the
    // row short of `width` and pi-tui's truncator trims + `…`'s it,
    // producing the vertical column of dots on the right edge.
    //
    // We do NOT run these rows through `truncateToWidth`: the styled
    // portrait's per-pixel chalk escape codes push `string-width` one
    // column past the plain portrait, so the truncator measures the row
    // as 1 col over `width` and lops the last visible char, appending
    // `…` to every row (the right-edge dot column). The rows are already
    // at most `width` visible cols by construction; `rightPad` is a single
    // dim-space chalk call so the row's string length still passes the
    // "≤ width" test invariant.
    // The glyph is shorter than the portrait (8 content rows vs 29),
    // so the trailing empty rows in `glyphLines` no longer sit at the
    // bottom — they're split: some go above, some below, so the content
    // rows land around mid-face. `GLYPH_TOP_BLANKS` = blank rows to
    // leave above the content; the rest fall below automatically because
    // the portrait is taller than the glyph.
    const GLYPH_TOP_BLANKS = 10;
    const sideBySide = coloredLogoLines.map((portraitLine, i) => {
      const glyphIndex = i - GLYPH_TOP_BLANKS;
      const glyphStyled =
        glyphIndex >= 0 && glyphIndex < coloredGlyphLines.length
          ? (coloredGlyphLines[glyphIndex] ?? "")
          : "";
      const glyphPlain =
        glyphIndex >= 0 && glyphIndex < glyphLines.length
          ? (glyphLines[glyphIndex] ?? "")
          : "";
      const glyphPad = " ".repeat(Math.max(0, GLYPH_WIDTH - glyphPlain.length));
      // The right margin is plain spaces, not chalk-painted, so the row's
      // `rightPad` count and the test's `line.length <= WIDTH` invariant
      // stay in sync. (`rightPad` is itself a string — see above — so
      // pad with `rightPad` directly, no second `.repeat`.)
      return `${indent}${portraitLine} ${glyphStyled}${glyphPad}${rightPad}`;
    });

    // Side-by-side rows are already at most `width` visible cols by
    // construction (padLeft + PORTRAIT_WIDTH + 1 + GLYPH_WIDTH + rightPad);
    // running them through `truncateToWidth` makes pi-tui's `string-width`
    // see them as 1 col over `width` (the per-pixel chalk escape codes
    // around the portrait's half-block chars round up) and append `…` to
    // every row — the right-edge column of dots the user saw. Skip the
    // truncator on those rows; apply it only to the plain-text subtitle /
    // stats / dir lines, whose `visibleWidth` matches their `.length`.
    const blockLines = [
      ...sideBySide,
      "", // gap between the logo and its subtitle
      ...[subtitleLine, ...updateLines, statsLine, dirLine].map((line) =>
        truncateToWidth(line, width),
      ),
    ];

    // Vertical centering: half the empty space goes above the block, the
    // other half below. `height === 0` (the renderer passed no height)
    // pins the block to the top — the legacy behaviour the test suite
    // exercises, since it calls `render(WIDTH)` with no height.
    const topPadCount = height > 0
      ? Math.max(0, Math.floor((height - blockLines.length) / 2))
      : 0;
    const topPad = Array.from({ length: topPadCount }, () => "");

    const lines = [...topPad, ...blockLines].slice(0, Math.max(height, blockLines.length));
    this.cache = {
      width,
      height,
      tools: toolCount,
      mcp: mcpCount,
      skills: skillCount,
      plugins: pluginCount,
      update: updateVersion,
      themeFingerprint,
      lines,
    };
    return lines;
  }
}
