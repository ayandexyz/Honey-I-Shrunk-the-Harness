import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRestoreBlock, RESTORE_FILE_CHARS, RESTORE_MAX_FILES } from "./restore.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-restore-"));
const file = (name: string, content: string | Buffer) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};

test("re-attaches the most recent files first, skipping kept, missing, binary and dirs", () => {
  const a = file("a.ts", "export const a = 1;\n");
  const b = file("b.ts", "export const b = 2;\n");
  const kept = file("kept.ts", "still in the transcript\n");
  const bin = file("img.png", Buffer.from([0x89, 0x50, 0x00, 0x01]));
  const block = buildRestoreBlock([b, kept, path.join(dir, "gone.ts"), bin, dir, a], new Set([kept]))!;
  assert.deepEqual(block.files.map((f) => path.basename(f.path)), ["b.ts", "a.ts"]);
  assert.ok(block.text.indexOf("export const b") < block.text.indexOf("export const a"), "newest first");
  assert.match(block.text, /re-attached after compaction/);
  assert.ok(!block.text.includes("still in the transcript"));
  assert.ok(block.files.every((f) => f.dedupSafe));
});

test("caps the file count and truncates a large file, which is then not dedup-safe", () => {
  const many = Array.from({ length: RESTORE_MAX_FILES + 2 }, (_, i) => file(`m${i}.ts`, `m${i}\n`));
  assert.equal(buildRestoreBlock(many, new Set())!.files.length, RESTORE_MAX_FILES);

  const big = file("big.ts", "x".repeat(RESTORE_FILE_CHARS + 10));
  const [f] = buildRestoreBlock([big], new Set())!.files;
  assert.equal(f!.dedupSafe, false, "the model has not seen the whole file");
  assert.match(buildRestoreBlock([big], new Set())!.text, /truncated at 20000 characters/);
});

test("a whole file a default read would show differently is not dedup-safe", () => {
  const longLine = file("long.ts", "y".repeat(2500));
  const manyLines = file("lines.ts", "z\n".repeat(2100));
  const files = buildRestoreBlock([longLine, manyLines], new Set())!.files;
  assert.deepEqual(files.map((f) => f.dedupSafe), [false, false]);
});

test("nothing to restore is undefined, not an empty block", () => {
  assert.equal(buildRestoreBlock([], new Set()), undefined);
  assert.equal(buildRestoreBlock([path.join(dir, "nope")], new Set()), undefined);
});

test("skills: most recent first, kept ones skipped, a big one truncated not dropped", async () => {
  const { buildSkillBlock, RESTORE_SKILL_CHARS } = await import("./restore.js");
  const block = buildSkillBlock(
    [
      { name: "newest", text: "<skill_content name=\"newest\">do X</skill_content>" },
      { name: "kept", text: "still in the transcript" },
      { name: "big", text: "T".repeat(RESTORE_SKILL_CHARS + 5) },
    ],
    new Set(["kept"]),
  )!;
  assert.equal(block.count, 2);
  assert.match(block.text, /re-attached after compaction/);
  assert.ok(block.text.indexOf("do X") < block.text.indexOf("TTT"), "newest first");
  assert.ok(!block.text.includes("still in the transcript"));
  assert.match(block.text, /truncated — load the skill again/);
  assert.equal(buildSkillBlock([], new Set()), undefined);
});

test("touched files are listed by path, modified apart from read, and capped", async () => {
  const { formatTouchedFiles, TOUCHED_FILES_MAX } = await import("./restore.js");
  const text = formatTouchedFiles(["a.ts"], ["b.ts"]);
  assert.match(text, /<modified-files>\nb\.ts\n<\/modified-files>\n<read-files>\na\.ts\n<\/read-files>/);
  assert.equal(formatTouchedFiles([], []), "");
  const many = Array.from({ length: TOUCHED_FILES_MAX + 10 }, (_, i) => `f${i}.ts`);
  assert.equal(formatTouchedFiles(many, []).split("\n").filter((l) => l.endsWith(".ts")).length, TOUCHED_FILES_MAX);
});
