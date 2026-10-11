import {
  getGifDimensions,
  getJpegDimensions,
  getPngDimensions,
  getWebpDimensions,
} from "@earendil-works/pi-tui";
import chalk from "chalk";

/**
 * The message list shows a window of its lines, but an inline image is ONE
 * escape sequence on its first line plus blank rows the terminal paints over.
 * Slicing through that block either drops the sequence (the image vanishes
 * when its top scrolls off) or keeps it with its full height (the image spills
 * past the window, over the editor). This re-emits a clipped image so it
 * covers exactly its visible rows: Kitty crops the source rectangle; anything
 * it can't crop becomes a one-line placeholder.
 */

const KITTY = "\x1b_G";
const ITERM2 = "\x1b]1337;File=";
const ITERM2_UP = /^\x1b\[(\d+)A/;

interface Block {
  /** Index of the block's first row in the full line array. */
  top: number;
  rows: number;
  kind: "kitty" | "iterm2";
}

function findBlock(lines: string[], i: number): Block | undefined {
  const line = lines[i]!;
  if (line.startsWith(KITTY)) {
    const params = line.slice(KITTY.length, line.indexOf(";"));
    const rows = Number(/(?:^|,)r=(\d+)/.exec(params)?.[1] ?? 1);
    return { top: i, rows: Math.max(1, rows), kind: "kitty" };
  }
  if (line.includes(ITERM2)) {
    const up = Number(ITERM2_UP.exec(line)?.[1] ?? 0);
    return { top: i - up, rows: up + 1, kind: "iterm2" };
  }
  return undefined;
}

function sourceSize(firstChunkBase64: string) {
  return (
    getPngDimensions(firstChunkBase64) ??
    getGifDimensions(firstChunkBase64) ??
    getWebpDimensions(firstChunkBase64) ??
    getJpegDimensions(firstChunkBase64)
  );
}

/** Kitty sequence showing rows [skip, skip+visible) of a `rows`-row image. */
export function cropKitty(
  line: string,
  rows: number,
  skip: number,
  visible: number,
): string | undefined {
  const paramsEnd = line.indexOf(";");
  const payloadEnd = line.indexOf("\x1b\\", paramsEnd);
  if (paramsEnd === -1 || payloadEnd === -1) return undefined;
  const size = sourceSize(line.slice(paramsEnd + 1, payloadEnd));
  if (!size) return undefined;
  // Kitty stretches the source rect over c×r cells, so the image maps onto its
  // rows uniformly and a row range is a proportional pixel range.
  const y = Math.floor((size.heightPx * skip) / rows);
  const h = Math.max(1, Math.floor((size.heightPx * (skip + visible)) / rows) - y);
  const params = line
    .slice(KITTY.length, paramsEnd)
    .split(",")
    .filter((p) => !/^[rxywh]=/.test(p));
  params.push(`r=${visible}`, "x=0", `y=${y}`, `w=${size.widthPx}`, `h=${h}`);
  return `${KITTY}${params.join(",")}${line.slice(paramsEnd)}`;
}

const placeholder = () => chalk.dim("[image — scroll to see it]");

/** `lines.slice(start, end)`, with any image cut by the window fitted to it. */
export function sliceWithImages(lines: string[], start: number, end: number): string[] {
  const window = lines.slice(start, end);
  // A Kitty sequence can sit up to its height above the window, an iTerm2 one
  // (on the block's LAST row) up to its height below. Image heights are
  // capped well under this margin.
  const margin = 200;
  for (let i = Math.max(0, start - margin); i < Math.min(end + margin, lines.length); i++) {
    const line = lines[i]!;
    // Image lines start with their sequence (iTerm2's behind a cursor-up), and
    // they are large — don't scan every one end to end.
    const isImage =
      line.startsWith(KITTY) ||
      line.startsWith(ITERM2) ||
      (ITERM2_UP.test(line) && line.includes(ITERM2));
    if (!isImage) continue;
    const block = findBlock(lines, i);
    if (!block) continue;
    const bottom = block.top + block.rows;
    const visTop = Math.max(block.top, start);
    const visBottom = Math.min(bottom, end);
    if (visTop >= visBottom) continue; // entirely outside
    if (visTop === block.top && visBottom === bottom) continue; // fully inside

    // Blank the block's visible rows, then draw into its first visible row.
    for (let r = visTop; r < visBottom; r++) window[r - start] = "";
    const cropped =
      block.kind === "kitty"
        ? cropKitty(line, block.rows, visTop - block.top, visBottom - visTop)
        : undefined;
    window[visTop - start] = cropped ?? placeholder();
  }
  return window;
}
