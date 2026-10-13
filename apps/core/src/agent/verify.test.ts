import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveVerifyCommand,
  runVerify,
  verifyFailureReminder,
} from "./verify.js";

async function tmpProject(pkg: unknown, files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fc-verify-"));
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

test("resolveVerifyCommand returns undefined when no package.json", () => {
  assert.equal(resolveVerifyCommand("/nonexistent/path/xyz"), undefined);
});

test("resolveVerifyCommand returns undefined when no matching script", async () => {
  const dir = await tmpProject({ scripts: { start: "node ." } });
  try {
    assert.equal(resolveVerifyCommand(dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveVerifyCommand prefers typecheck and detects pnpm", async () => {
  const dir = await tmpProject(
    { scripts: { build: "x", typecheck: "tsc --noEmit" } },
    { "pnpm-lock.yaml": "" },
  );
  try {
    assert.deepEqual(resolveVerifyCommand(dir), {
      command: "pnpm run typecheck",
      label: "typecheck",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveVerifyCommand falls back to build with npm default", async () => {
  const dir = await tmpProject({ scripts: { build: "tsc" } });
  try {
    assert.deepEqual(resolveVerifyCommand(dir), {
      command: "npm run build",
      label: "build",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runVerify reports ok on exit 0 and failure with output on non-zero", async () => {
  const signal = new AbortController().signal;
  const pass = await runVerify("exit 0", process.cwd(), signal);
  assert.equal(pass.ok, true);

  const fail = await runVerify("echo boom >&2; exit 1", process.cwd(), signal);
  assert.equal(fail.ok, false);
  assert.match(fail.output, /boom/);
});

test("verifyFailureReminder embeds label and output in a system-reminder", () => {
  const r = verifyFailureReminder("typecheck", "TS2322: nope");
  assert.match(r, /<system-reminder>/);
  assert.match(r, /typecheck/);
  assert.match(r, /TS2322: nope/);
});

test("a timed-out command is killed with its children, so a test runner that leaves a process holding stdout cannot hang the gate", { timeout: 15_000 }, async () => {
  // `pnpm -C dir test` → sh → node workers: SIGTERM to the top shell alone
  // left the grandchild holding stdout, and "close" never fired.
  const started = Date.now();
  const r = await runVerify("sleep 30 & wait", process.cwd(), new AbortController().signal, 300);
  assert.equal(r.ok, false);
  assert.match(r.output, /timed out/);
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
});

test("an abort stops the whole process group too", { timeout: 15_000 }, async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const started = Date.now();
  const r = await runVerify("sleep 30 & wait", process.cwd(), ac.signal, 60_000);
  assert.equal(r.ok, false);
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
});
