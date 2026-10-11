import test from "node:test";
import assert from "node:assert/strict";
import { encodeKitty, encodeITerm2 } from "@earendil-works/pi-tui";
import { sliceWithImages } from "./image-clip.js";

// A 100×200 PNG header: signature, IHDR length+type, width, height.
const png = Buffer.alloc(33);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
png.writeUInt32BE(100, 16);
png.writeUInt32BE(200, 20);
const kittyLine = encodeKitty(png.toString("base64"), {
  columns: 10,
  rows: 4,
  imageId: 7,
  moveCursor: false,
});

/** text, 4-row kitty image, text */
const kittyLines = ["a", kittyLine, "", "", "", "b"];

const params = (line: string) => line.slice(3, line.indexOf(";")).split(",");

test("an image fully inside the window is left untouched", () => {
  assert.deepEqual(sliceWithImages(kittyLines, 0, 6), kittyLines);
});

test("an image whose top scrolled off is cropped onto its first visible row", () => {
  // Window starts two rows into the image: rows 2–3 of 4 remain.
  const window = sliceWithImages(kittyLines, 3, 6);
  assert.equal(window.length, 3);
  const p = params(window[0]!);
  assert.ok(p.includes("r=2"), "drawn over the two visible rows");
  assert.ok(p.includes("y=100") && p.includes("h=100"), "bottom half of 200px");
  assert.ok(p.includes("i=7"), "keeps its id so the old placement is replaced");
  assert.deepEqual(window.slice(1), ["", "b"]);
});

test("an image cut by the window's bottom stops at the window", () => {
  // Window ends two rows into the image: rows 0–1 of 4 remain.
  const window = sliceWithImages(kittyLines, 0, 3);
  const p = params(window[1]!);
  assert.ok(p.includes("r=2") && p.includes("y=0") && p.includes("h=100"));
  assert.equal(window[2], "");
});

test("a window entirely past the image carries no sequence", () => {
  assert.deepEqual(sliceWithImages(kittyLines, 5, 6), ["b"]);
});

test("a clipped iTerm2 image becomes a placeholder, never a stray sequence", () => {
  const seq = `\x1b[2A${encodeITerm2(png.toString("base64"), { width: 10 })}`;
  const lines = ["a", "", "", seq, "b"];
  const window = sliceWithImages(lines, 0, 2);
  assert.equal(window[0], "a");
  assert.match(window[1]!, /scroll to see it/);
  assert.ok(!window.some((l) => l.includes("1337")));
});
