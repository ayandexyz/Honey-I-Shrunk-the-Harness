import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  failingTestLines,
  loadVerifySettings,
  resolveTestCommands,
  testFailureReminder,
} from "./verify-tests.js";

function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-verify-tests-"));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
}
const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts });
const ON = { tests: true };

test("monorepo with no root test script: each changed file's own package runs its tests", () => {
  const dir = repo({
    "package.json": pkg({ typecheck: "tsc" }),
    "pnpm-lock.yaml": "",
    "apps/core/package.json": pkg({ test: "tsx --test" }),
    "apps/core/src/a.ts": "",
    "apps/core/src/b.ts": "",
    "apps/tui/package.json": pkg({ test: "tsx --test" }),
    "apps/tui/src/c.ts": "",
  });
  const cmds = resolveTestCommands(dir, ["apps/core/src/a.ts", path.join(dir, "apps/core/src/b.ts"), "apps/tui/src/c.ts"], ON);
  assert.deepEqual(cmds.map((c) => c.command), [
    `pnpm -C '${path.join(dir, "apps/core")}' test`,
    `pnpm -C '${path.join(dir, "apps/tui")}' test`,
  ]);
  assert.deepEqual(cmds.map((c) => c.label), ["tests (apps/core)", "tests (apps/tui)"]);
});

test("single-package npm repo uses --prefix at the root; npm's placeholder test script is no test script", () => {
  const real = repo({ "package.json": pkg({ test: "node --test" }), "src/a.js": "" });
  assert.deepEqual(resolveTestCommands(real, ["src/a.js"], ON).map((c) => c.command), [`npm --prefix '${real}' test`]);
  const placeholder = repo({ "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1' }), "src/a.js": "" });
  assert.deepEqual(resolveTestCommands(placeholder, ["src/a.js"], ON), []);
});

test("settings: testCommand overrides discovery; tests:false and the env switch turn it off", () => {
  const dir = repo({ ".freecode/settings.json": JSON.stringify({ verify: { testCommand: "make check" } }) });
  const s = loadVerifySettings(dir, {});
  assert.deepEqual(s, { tests: true, testCommand: "make check" });
  assert.deepEqual(resolveTestCommands(dir, ["x.ts"], s), [{ command: "make check", label: "tests" }]);
  assert.equal(loadVerifySettings(dir, { FREECODE_VERIFY_TESTS: "0" }).tests, false);
  assert.equal(loadVerifySettings(dir, { FREECODE_VERIFY_TEST_COMMAND: "just test" }).testCommand, "just test");
  const off = repo({ ".freecode/settings.json": JSON.stringify({ verify: { tests: false } }) });
  assert.equal(loadVerifySettings(off, {}).tests, false);
});

test("failing lines come from the whole output, not the clipped tail", () => {
  const raw = ["ok 1 - fine", "not ok 709 - every handler is declared", ...Array(5000).fill("noise"), "✖ providers.list (3ms)", "# fail 2"].join("\n");
  assert.deepEqual(failingTestLines(raw), ["not ok 709 - every handler is declared", "✖ providers.list (3ms)"]);
  const r = testFailureReminder([{ label: "tests (apps/core)", raw }]);
  assert.match(r, /tests \(apps\/core\) failed/);
  assert.match(r, /not ok 709 - every handler is declared/);
  assert.match(r, /already failing before your change, say so/);
});

test("the test gate runs only for a top-level, attended run of ≥3 files with attempts left", async () => {
  const { shouldRunTestGate } = await import("./verify-tests.js");
  const ok = { filesChanged: 3, attempts: 0, enabled: true, unattended: false };
  assert.equal(shouldRunTestGate(ok), true);
  assert.equal(shouldRunTestGate({ ...ok, filesChanged: 2 }), false, "small edits stay fast");
  assert.equal(shouldRunTestGate({ ...ok, attempts: 2 }), false, "own cap of 2");
  // A subagent's tests are its parent's to run: a background subagent and its
  // parent would otherwise run the same suite at once.
  assert.equal(shouldRunTestGate({ ...ok, enabled: false }), false);
  // A night run's bash is sandboxed and its commits gated by --verify; the
  // gate would run a model-written test file outside the sandbox.
  assert.equal(shouldRunTestGate({ ...ok, unattended: true }), false);
});
