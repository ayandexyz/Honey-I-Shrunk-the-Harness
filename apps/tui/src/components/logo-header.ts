import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import chalk, { Chalk } from "chalk";
import { PORTRAIT_WIDTH, portraitLines } from "../assets/portrait.js";
import { getDisplayDirectory, getVersion } from "../utils/display.js";
import { palette } from "../palette.js";

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

const LOGO_WIDTH = PORTRAIT_WIDTH;

/** Blank rows rendered above the logo. */
const TOP_PADDING = 4;

/** "-1" sentinel from the index.ts cache means "not loaded yet". */
const PENDING = "…";

/**
 * Pinned top-of-TUI logo header. Renders the ASCII portrait logo (centered,
 * truecolour) with the `>_ Histh! (vX.Y.Z)` subtitle, a compact stats line
 * (tools/MCP/skills/plugins counts) and a directory line — all centered and in yellow.
 *
 * The counts come from accessor functions so the parent can cache them
 * once at startup and the header stays synchronous.
 */
export class LogoHeader implements Component {
  /**
   * Rendered every frame as the message list's first entry (even in follow
   * mode, where the window slice usually discards it), so the lines are
   * cached on everything they actually depend on: width and the counts
   * (version and cwd are fixed for the process).
   */
  private cache?: {
    width: number;
    tools: number;
    mcp: number;
    skills: number;
    plugins: number;
    update: string | null;
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

  render(width: number): string[] {
    if (width < LOGO_WIDTH) {
      // Too narrow for the portrait; skip the overlay rather than truncating it.
      return [];
    }

    const toolCount = this.getToolCount();
    const mcpCount = this.getMcpCount();
    const skillCount = this.getSkillCount();
    const pluginCount = this.getPluginCount();
    const updateVersion = this.getUpdateVersion();
    if (
      this.cache &&
      this.cache.width === width &&
      this.cache.tools === toolCount &&
      this.cache.mcp === mcpCount &&
      this.cache.skills === skillCount &&
      this.cache.plugins === pluginCount &&
      this.cache.update === updateVersion
    ) {
      return this.cache.lines;
    }

    const padLeft = Math.max(0, Math.floor((width - LOGO_WIDTH) / 2));
    const padRight = Math.max(0, width - LOGO_WIDTH - padLeft);
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

    // Breathing room above the logo so it does not sit flush against the
    // status bar.
    const topPad = Array.from({ length: TOP_PADDING }, () => "");

    const lines = [
      ...topPad,
      ...coloredLogoLines.map((logoLine) => `${indent}${logoLine}${rightPad}`),
      "", // gap between the logo and its subtitle
      subtitleLine,
      ...updateLines,
      statsLine,
      dirLine,
    ].map((line) => truncateToWidth(line, width));
    this.cache = {
      width,
      tools: toolCount,
      mcp: mcpCount,
      skills: skillCount,
      plugins: pluginCount,
      update: updateVersion,
      lines,
    };
    return lines;
  }
}
