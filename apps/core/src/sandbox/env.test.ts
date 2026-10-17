// =============================================================================
// The sandbox environment: what a sandboxed shell inherits, and how the user's
// toolchains come back after $HOME is replaced with a tmpfs.
// Spec: docs/specs/2026-09-27-agent-control-and-definitions.md §5.5
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { homeToolchainMounts, sandboxEnvironment } from "./env.js";

test("sandboxed shells do not inherit credentials", () => {
  const old = process.env.FREECODE_TEST_SECRET_TOKEN;
  process.env.FREECODE_TEST_SECRET_TOKEN = "do-not-forward";
  try {
    assert.equal(sandboxEnvironment().FREECODE_TEST_SECRET_TOKEN, undefined);
    assert.equal(process.env.FREECODE_TEST_SECRET_TOKEN, "do-not-forward");
    assert.ok(sandboxEnvironment().PATH, "ordinary execution variables remain");
  } finally {
    if (old === undefined) delete process.env.FREECODE_TEST_SECRET_TOKEN;
    else process.env.FREECODE_TEST_SECRET_TOKEN = old;
  }
});

test("home toolchains on PATH are mounted read-only while credential roots stay hidden", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "night-sandbox-home-"));
  const miseBin = path.join(
    home,
    ".local",
    "share",
    "mise",
    "installs",
    "node",
    "1",
    "bin",
  );
  const secretBin = path.join(home, ".config", "private", "bin");
  const disguisedSecretBin = path.join(home, ".local", "disguised-secret");
  fs.mkdirSync(miseBin, { recursive: true });
  fs.mkdirSync(secretBin, { recursive: true });
  fs.symlinkSync(secretBin, disguisedSecretBin, "dir");
  try {
    const args = homeToolchainMounts(
      {
        PATH: [miseBin, secretBin, disguisedSecretBin, "/usr/bin"].join(
          path.delimiter,
        ),
      },
      home,
    );
    const miseRoot = path.join(home, ".local", "share", "mise");
    const at = args.findIndex(
      (arg, i) => arg === "--ro-bind" && args[i + 2] === miseRoot,
    );
    assert.ok(at >= 0, "mise is exposed from its manager root");
    assert.equal(args[at + 1], fs.realpathSync(miseRoot));
    assert.ok(
      !args.includes(secretBin),
      "configuration directories remain hidden",
    );
    assert.ok(
      !args.includes(disguisedSecretBin),
      "symlinks into configuration directories remain hidden",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
