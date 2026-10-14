// Edit-time diagnostics against a fake language server: every "ERR: <msg>"
// line in a document is an error; "SLOW" delays the push past the drain's cap.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disposeAll, resolveCommand } from "./client.js";
import { drainEditDiagnostics, noteEdit, noteRead } from "./feedback.js";

const SERVER = `
let buf = Buffer.alloc(0);
const send = (m) => { const j = JSON.stringify({ jsonrpc: "2.0", ...m }); process.stdout.write("Content-Length: " + Buffer.byteLength(j) + "\\r\\n\\r\\n" + j); };
const publish = (uri, text) => setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: { uri,
  diagnostics: text.split("\\n").flatMap((l, i) => l.startsWith("ERR: ") ? [{ range: { start: { line: i, character: 0 } }, severity: 1, message: l.slice(5) }] : []) } }),
  text.includes("SLOW") ? 3000 : 30);
process.stdin.on("data", (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const h = buf.indexOf("\\r\\n\\r\\n"); if (h < 0) return;
    const len = +/Content-Length: (\\d+)/i.exec(buf.subarray(0, h).toString())[1];
    if (buf.length < h + 4 + len) return;
    const m = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString()); buf = buf.subarray(h + 4 + len);
    if (m.method === "initialize") send({ id: m.id, result: { capabilities: {} } });
    if (m.method === "textDocument/didOpen") publish(m.params.textDocument.uri, m.params.textDocument.text);
    if (m.method === "textDocument/didChange") publish(m.params.textDocument.uri, m.params.contentChanges[0].text);
  }
});`;

const dir = mkdtempSync(join(tmpdir(), "freecode-edit-diag-"));
const serverPath = join(dir, "fake-lsp.cjs");
writeFileSync(serverPath, SERVER);
process.env.FREECODE_EDIT_DIAGNOSTICS = "1";
process.env.FREECODE_LSP_SERVERS = JSON.stringify({ ".fk": { command: "node", args: [serverPath] } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test.after(() => {
  disposeAll();
  rmSync(dir, { recursive: true, force: true });
});

test("pre-existing errors are a silent baseline; a new one is reported once per edit", async () => {
  const file = join(dir, "a.fk");
  writeFileSync(file, "ok\nERR: old\n");
  noteRead("s1", file, dir);
  await sleep(500); // server start + baseline push
  assert.equal(await drainEditDiagnostics("s1"), undefined, "baseline alone reports nothing");

  writeFileSync(file, "ok\nERR: old\nERR: new\n");
  noteEdit("s1", file, dir);
  const d = await drainEditDiagnostics("s1");
  assert.ok(d, "the new error arrives at the next drain");
  assert.match(d.text, /a\.fk\n {2}ERROR 3:1 new/);
  assert.doesNotMatch(d.text, /old/);
  assert.equal(d.errors, 1);

  assert.equal(await drainEditDiagnostics("s1"), undefined, "no edit, no repeat");

  writeFileSync(file, "ERR: new\nok\nERR: old\n");
  noteEdit("s1", file, dir);
  const again = await drainEditDiagnostics("s1");
  assert.match(again?.text ?? "", /ERROR 1:1 new/, "still broken after another edit is said again");

  writeFileSync(file, "ok\nERR: old\n");
  noteEdit("s1", file, dir);
  assert.equal(await drainEditDiagnostics("s1"), undefined, "fixed: nothing to say");
});

test("a file edited before it was ever read has no baseline", async () => {
  const file = join(dir, "b.fk");
  writeFileSync(file, "ERR: was here\n");
  noteEdit("s2", file, dir);
  const d = await drainEditDiagnostics("s2");
  assert.match(d?.text ?? "", /was here/);
});

test("a slow server costs the drain at most its cap, and the late push is not lost", async () => {
  const file = join(dir, "c.fk");
  writeFileSync(file, "SLOW\nERR: late\n");
  noteEdit("s3", file, dir);
  const started = Date.now();
  assert.equal(await drainEditDiagnostics("s3"), undefined);
  assert.ok(Date.now() - started < 2_500, `waited ${Date.now() - started}ms`);
  await sleep(2_000);
  assert.match((await drainEditDiagnostics("s3"))?.text ?? "", /late/);
});

test("off by default", async () => {
  delete process.env.FREECODE_EDIT_DIAGNOSTICS;
  const file = join(dir, "d.fk");
  writeFileSync(file, "ERR: x\n");
  noteEdit("s4", file, dir);
  assert.equal(await drainEditDiagnostics("s4"), undefined);
  process.env.FREECODE_EDIT_DIAGNOSTICS = "1";
});

test("a server is found in the project's node_modules before PATH", () => {
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "node"), "");
  assert.equal(resolveCommand("node", dir), join(bin, "node"));
  assert.notEqual(resolveCommand("node", tmpdir()), undefined, "falls back to PATH");
  assert.equal(resolveCommand("no-such-lsp-server", dir), undefined);
});
