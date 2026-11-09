// =============================================================================
// --settings — every command accepts hooks for this one process, the way
// `claude --settings` does. It travels as FREECODE_SETTINGS so the backend the
// TUI spawns inherits it.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import type { CommandModule } from "yargs";
import { createCli } from "./create-cli.js";

const noop: CommandModule = {
  command: "noop",
  describe: "test command",
  handler: () => {},
};

async function parseWithEnv(args: string[]): Promise<string | undefined> {
  const previous = process.env.FREECODE_SETTINGS;
  delete process.env.FREECODE_SETTINGS;
  try {
    await createCli([noop]).parseAsync(args);
    return process.env.FREECODE_SETTINGS;
  } finally {
    if (previous === undefined) delete process.env.FREECODE_SETTINGS;
    else process.env.FREECODE_SETTINGS = previous;
  }
}

test("--settings resolves a relative path against the launch directory", async () => {
  const value = await parseWithEnv(["noop", "--settings", "hooks/board.json"]);
  assert.equal(value, path.resolve(process.cwd(), "hooks/board.json"));
});

test("--settings passes an inline JSON document through unchanged", async () => {
  const doc = '{"hooks":{"Stop":[{"command":"true"}]}}';
  assert.equal(await parseWithEnv(["noop", "--settings", doc]), doc);
});

test("without --settings the environment is left alone", async () => {
  assert.equal(await parseWithEnv(["noop"]), undefined);
});
