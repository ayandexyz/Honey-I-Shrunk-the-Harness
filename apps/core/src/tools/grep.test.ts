import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GrepTool, ripgrepPath, runRipgrep } from "./grep.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-grep-"));
fs.writeFileSync(path.join(tmp, "a.ts"), "const needle = 1;\n");

const ctx = { cwd: tmp, sessionId: "test-grep", abort: new AbortController().signal };

async function grep(params: Record<string, unknown>) {
  return (await GrepTool.execute(params as any, ctx as any)) as any;
}

test("spawning a missing binary is exit 127, not \"no matches\"", async () => {
  const res = await runRipgrep(["x", tmp], path.join(tmp, "no-such-rg"));
  assert.equal(res.exitCode, 127);
});

test("bundled rg beside the executable wins over PATH", () => {
  const bin = path.join(tmp, process.platform === "win32" ? "rg.exe" : "rg");
  assert.equal(ripgrepPath(path.join(tmp, "freecode"), true), "rg");
  fs.writeFileSync(bin, "");
  assert.equal(ripgrepPath(path.join(tmp, "freecode"), true), bin);
  assert.equal(ripgrepPath(path.join(tmp, "node"), false), "rg");
  fs.rmSync(bin);
});

test("not installed → success:false with the bash fallback", async () => {
  const prev = process.env.PATH;
  // An empty PATH falls back to /usr/bin:/bin; an empty dir does not.
  process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-nopath-"));
  try {
    const res = await grep({ pattern: "needle" });
    assert.equal(res.success, false);
    assert.match(res.error, /not installed[\s\S]*grep -rn/);
  } finally {
    process.env.PATH = prev;
  }
});

// The rest need a real rg; skip where there is none (like the bench image).
const hasRg = (await runRipgrep(["--version"])).exitCode === 0;

test("match, no match and a bad regex are three different results", { skip: !hasRg }, async () => {
  const hit = await grep({ pattern: "needle" });
  assert.equal(hit.success, true);
  assert.match(hit.result.output, /a\.ts:1:const needle/);

  const miss = await grep({ pattern: "haystack" });
  assert.equal(miss.success, true);
  assert.equal(miss.result.output, "No matches found");

  const bad = await grep({ pattern: "(" });
  assert.equal(bad.success, false);
  assert.match(bad.error, /regex/i);
});
