import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkUnwired,
  declarationsIn,
  findUncalled,
  isTestPath,
  newDeclarations,
  unwiredReminder,
} from "./unwired.js";

test("declarationsIn finds functions, arrow consts, classes and methods — not calls or types", () => {
  const src = [
    "export function alpha(x) {",
    "export const beta = async (y) => y;",
    "export class Gamma {",
    "  attachLoop(id: string, loop: { steer: (t: string) => void }): void {",
    "  private async delta() {",
    "  if (ready) {",
    "  setTimeout(() => {",
    "  items.forEach((x) => {",
    "export interface Epsilon { a: number }",
    "export type Zeta = string;",
  ].join("\n");
  assert.deepEqual(
    declarationsIn(src, "a.ts").map((d) => `${d.name}:${d.line}`),
    ["alpha:1", "beta:2", "Gamma:3", "attachLoop:4", "delta:5"],
  );
});

test("newDeclarations is what the edit added, by name", () => {
  const before = "export function kept() {\n";
  const after = "export function kept() {\nexport function added() {\n";
  assert.deepEqual(newDeclarations(before, after, "m.ts"), [{ name: "added", file: "m.ts", line: 2 }]);
  assert.deepEqual(newDeclarations("", "", "m.ts"), []);
});

test("isTestPath", () => {
  for (const p of ["a.test.ts", "src/x.spec.mjs", "pkg/__tests__/y.ts"]) assert.equal(isTestPath(p), true, p);
  for (const p of ["src/testing.ts", "src/latest.ts"]) assert.equal(isTestPath(p), false, p);
});

test("findUncalled ignores the definition line and test files", () => {
  const decl = { name: "attachLoop", file: "src/registry.ts", line: 40 };
  const onlyTests = () => ["src/registry.ts:40:  attachLoop(id) {", "src/registry.test.ts:12:  reg.attachLoop(\"a1\")"];
  assert.deepEqual(findUncalled([decl], onlyTests), [decl]);
  const called = () => [...onlyTests(), "src/tools/agent.ts:88:    registry.attachLoop(id, loop);"];
  assert.deepEqual(findUncalled([decl], called), []);
});

test("checkUnwired on a real git repo: a new method only tests call is reported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-unwired-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });
  try {
    git("init", "-q");
    const reg = path.join(dir, "registry.ts");
    const before = "export class Registry {\n  register(id: string) {\n  }\n}\n";
    fs.writeFileSync(reg, before);
    fs.writeFileSync(path.join(dir, "main.ts"), "new Registry().register('a');\n");
    git("add", "-A");
    // The run adds attachLoop; only a test calls it. setTimeout is a call, not a declaration.
    fs.writeFileSync(reg, "export class Registry {\n  register(id: string) {\n  }\n  attachLoop(id: string) {\n    setTimeout(() => {\n    });\n  }\n}\n");
    fs.writeFileSync(path.join(dir, "registry.test.ts"), "new Registry().attachLoop('a');\n");
    git("add", "-A");
    const found = checkUnwired(dir, new Map([[reg, before]]));
    assert.deepEqual(found.map((d) => `${d.name}@${d.file}:${d.line}`), ["attachLoop@registry.ts:4"]);
    assert.match(unwiredReminder(found), /attachLoop \(registry\.ts:4\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkUnwired outside a git repo is skipped, not an error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-unwired-nogit-"));
  try {
    const f = path.join(dir, "a.ts");
    fs.writeFileSync(f, "export function lonely() {\n}\n");
    assert.deepEqual(checkUnwired(dir, new Map([[f, null]])), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a comment that names a function is not a caller; a string still is", () => {
  // add-agent-control v2 t1: attachLoop's only non-test "references" were its
  // own doc comments, so the first calibration missed it.
  const decl = { name: "attachLoop", file: "src/registry.ts", line: 40 };
  const commentsOnly = () => [
    "src/registry.ts:12:   * Steers queued before `attachLoop` could deliver them.",
    "src/registry.ts:55:    // and `attachLoop`), but pinning the rule in one place",
    "src/registry.ts:60:  /* attachLoop replays them */",
  ];
  assert.deepEqual(findUncalled([decl], commentsOnly), [decl]);
  const viaString = () => [...commentsOnly(), "src/dispatch.ts:3:  handlers[\"attachLoop\"](id);"];
  assert.deepEqual(findUncalled([decl], viaString), []);
});

test("one batched git grep answers many names, whole words only", async () => {
  const { gitGrepMany } = await import("./unwired.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freecode-unwired-many-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "a.ts"), "add(1);\naddAll([1]);\nremove(2);\n");
    const hits = gitGrepMany(dir, ["add", "remove", "absent"])!;
    assert.deepEqual(hits.get("add"), ["a.ts:1:add(1);"], "addAll is not a reference to add");
    assert.deepEqual(hits.get("remove"), ["a.ts:3:remove(2);"]);
    assert.deepEqual(hits.get("absent") ?? [], []);
    assert.equal(gitGrepMany(os.tmpdir() + "/definitely-not-a-repo-" + process.pid, ["x"]), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
