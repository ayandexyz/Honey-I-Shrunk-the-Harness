import assert from "node:assert/strict";
import test from "node:test";
import stringWidth from "string-width";
import { LogoHeader } from "./logo-header.js";

const WIDTH = 100;
const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

function render(update: string | null): string[] {
  const header = new LogoHeader(
    () => 10,
    () => 2,
    () => 5,
    () => 1,
    () => update,
  );
  return header.render(WIDTH).map(strip);
}

test("no update notice while the probe is pending or empty", () => {
  const lines = render(null);
  assert.ok(
    lines.some((l) => l.includes(">_ Histh!")),
    "subtitle should still render",
  );
  assert.ok(!lines.some((l) => l.includes("update available")));
});

test("update notice renders directly under the subtitle", () => {
  const lines = render("0.39.0");
  const subtitleAt = lines.findIndex((l) => l.includes(">_ Histh!"));
  const noticeAt = lines.findIndex((l) => l.includes("update available"));
  assert.notEqual(subtitleAt, -1);
  assert.equal(noticeAt, subtitleAt + 1, "notice belongs right below the version");
  assert.ok(lines[noticeAt].includes("(v0.39.0)"));
  assert.ok(lines[noticeAt].includes("freecode update"));
  // Stats line is pushed down, not replaced.
  assert.ok(lines.some((l) => l.includes("Tools: 10")));
});

test("every rendered line stays within the terminal width", () => {
  for (const line of render("0.39.0")) {
    // Use visible width, not raw string length — the side-by-side header
    // rows carry per-pixel chalk escape codes around the portrait, so
    // their `line.length` (ANSI bytes included) is intentionally larger
    // than their visible width.
    assert.ok(stringWidth(line) <= WIDTH, `line too wide: ${JSON.stringify(line)}`);
  }
});

test("the cache notices an update arriving after the first render", () => {
  let update: string | null = null;
  const header = new LogoHeader(
    () => 10,
    () => 2,
    () => 5,
    () => 1,
    () => update,
  );
  const before = header.render(WIDTH).map(strip);
  assert.ok(!before.some((l) => l.includes("update available")));
  update = "0.39.0";
  const after = header.render(WIDTH).map(strip);
  assert.ok(
    after.some((l) => l.includes("update available")),
    "a cached render must not hide a probe result that arrived later",
  );
});
