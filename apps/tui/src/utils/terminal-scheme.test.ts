import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectTerminalScheme, schemeForBackground } from "./terminal-scheme.js";
import type { OmarchyPalette } from "./omarchy-theme.js";

// The palette reads the Omarchy theme from $HOME at import; point it at an
// empty dir so these run as "off Omarchy" on every machine, Omarchy included.
process.env.HOME = mkdtempSync(join(tmpdir(), "freecode-scheme-"));
const { palette, refreshPalette, setTerminalScheme } = await import("../palette.js");
const { OMARCHY_KEYS } = await import("./omarchy-theme.js");

test("background luminance decides light vs dark", () => {
  assert.equal(schemeForBackground({ r: 255, g: 255, b: 255 }), "light");
  assert.equal(schemeForBackground({ r: 253, g: 246, b: 227 }), "light"); // solarized light
  assert.equal(schemeForBackground({ r: 0, g: 43, b: 54 }), "dark"); // solarized dark
  assert.equal(schemeForBackground({ r: 30, g: 30, b: 30 }), "dark");
});

const fakeTui = (scheme?: "light" | "dark", bg?: { r: number; g: number; b: number }) => ({
  queryTerminalColorScheme: async () => scheme,
  queryTerminalBackgroundColor: async () => bg,
});

test("a reported scheme wins; the background is the fallback; silence is undefined", async () => {
  assert.equal(await detectTerminalScheme(fakeTui("light", { r: 0, g: 0, b: 0 })), "light");
  assert.equal(await detectTerminalScheme(fakeTui(undefined, { r: 250, g: 250, b: 250 })), "light");
  assert.equal(await detectTerminalScheme(fakeTui()), undefined);
});

test("a light scheme repaints captured paints; repeating it is a no-op", () => {
  const fg = palette.fg; // captured the way components do
  const dark = fg("x");
  assert.equal(setTerminalScheme("light"), true);
  assert.notEqual(fg("x"), dark, "captured paint did not follow the scheme");
  assert.equal(setTerminalScheme("light"), false);
  assert.equal(setTerminalScheme("dark"), true);
  assert.equal(fg("x"), dark, "dark restores the original palette");
});

test("an Omarchy theme is never overridden by the terminal scheme", () => {
  const theme = Object.fromEntries(OMARCHY_KEYS.map((k) => [k, "#445566"])) as OmarchyPalette;
  assert.equal(refreshPalette(() => theme), true);
  assert.equal(setTerminalScheme("light"), false);
});
