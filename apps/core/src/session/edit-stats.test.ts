import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "freecode-edit-stats-home-"));
process.env.HOME = home;

const { countLineChanges, recordEditStats, readEditStats } = await import(
  "./edit-stats.js"
);
const { formatSessionDirName } = await import("../store/path-formatter.js");

test.after(() => rmSync(home, { recursive: true, force: true }));

test("a replaced line counts once each way; a new file counts every line", () => {
  assert.deepEqual(countLineChanges("a\nb\nc\n", "a\nB\nc\n"), { added: 1, removed: 1 });
  assert.deepEqual(countLineChanges("", "one\ntwo\n"), { added: 2, removed: 0 });
  assert.deepEqual(countLineChanges("same\n", "same\n"), { added: 0, removed: 0 });
});

test("edits accumulate per session, and a session with no directory records nothing", async () => {
  const project = "/work/app";
  const dir = join(home, ".freecode", "sessions", formatSessionDirName(project), "s1");
  mkdirSync(dir, { recursive: true });

  recordEditStats("s1", project, "a\n", "a\nb\n");
  recordEditStats("s1", project, "a\nb\n", "x\n");
  assert.deepEqual(await readEditStats("s1", project), { added: 2, removed: 2 });

  recordEditStats("missing", project, "", "a\n");
  assert.equal(await readEditStats("missing", project), undefined);
});
