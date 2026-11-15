// MCP OAuth Phase 2 (spec 2026-11-15-mcp-oauth): a server that needs a login
// offers an `authenticate` tool, and a login — from that tool or from another
// terminal — swaps in the server's real tools without a restart.
//
// Runs the real `initMcpServers` path, so HOME is pointed at a temp dir BEFORE
// anything reads it (`MCP_AUTH_FILE` and the config dir are resolved from it).
// node:test runs each file in its own process, so this cannot leak.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { browser, type Fake, remote, startFake } from "./fake-oauth-server.test.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-home-"));
process.env.HOME = home;
process.env.FREECODE_MCP_CLAUDE_CODE = "0";

const { initMcpServers, stopMcpServers } = await import("../init.js");
const { getTool } = await import("../../tools/index.js");
const { takeMcpAuthNotices } = await import("./needs-auth.js");
const { loginMcpServer } = await import("./login.js");
const { MCP_AUTH_FILE } = await import("./store.js");

let fake: Fake;

before(async () => {
  assert.ok(MCP_AUTH_FILE.startsWith(home), "the store must live under the temp HOME");
  fake = await startFake();
  fs.mkdirSync(path.join(home, ".freecode"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".freecode", "config.json"),
    JSON.stringify({ mcp: { servers: [remote(fake)] } }),
  );
});

after(async () => {
  await stopMcpServers();
  await fake.close();
});

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const ctx = { cwd: home };

test("a server that needs a login offers only an authenticate tool, and says so once", async () => {
  await initMcpServers();
  assert.ok(getTool("mcp__fake__authenticate"));
  assert.equal(getTool("mcp__fake__ping"), undefined);
  const notices = takeMcpAuthNotices();
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /"fake" needs a login/);
  assert.deepEqual(takeMcpAuthNotices(), [], "delivered once");
  assert.equal(fake.registrations, 0, "a connect registers nothing");
});

test("an unattended run is told no one can sign in, and no sign-in starts", async () => {
  const tool = getTool("mcp__fake__authenticate")!;
  const result = await tool.execute({}, { ...ctx, unattended: {} as never });
  assert.equal(result.success, false);
  assert.match((result as { error: string }).error, /nobody is here/);
  assert.equal(fake.registrations, 0);
});

test("authenticate returns a URL; finishing it swaps in the real tools without a restart", async () => {
  const tool = getTool("mcp__fake__authenticate")!;
  const first = await tool.execute({}, ctx);
  assert.equal(first.success, true);
  const output = (first as { result: { output: string } }).result.output;
  const url = output.match(/https?:\/\/\S+\/authorize\S*/)?.[0];
  assert.ok(url, "the result carries the authorization URL");

  // Asking again while the first sign-in waits reuses it.
  const again = await tool.execute({}, ctx);
  assert.match((again as { result: { output: string } }).result.output, new RegExp(url!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(fake.registrations, 1);

  browser(new URL(url!));
  await until(() => getTool("mcp__fake__ping") !== undefined);
  assert.equal(getTool("mcp__fake__authenticate"), undefined, "the real tools replace it");
  assert.ok(takeMcpAuthNotices().some((n) => /Signed in to MCP server "fake" — 1 tools/.test(n)));
});

test("a login from another terminal is picked up by the running process", async () => {
  // Back to needs-auth: the server forgets every token, and we drop ours.
  await stopMcpServers();
  fs.rmSync(MCP_AUTH_FILE, { force: true });
  fake.valid.clear();
  await initMcpServers();
  assert.ok(getTool("mcp__fake__authenticate"));
  takeMcpAuthNotices();

  // What `freecode mcp login fake` does, in a separate process.
  await loginMcpServer({
    server: remote(fake),
    onAuthorizationUrl: browser,
    waitForCode: (callback, state) => callback!.waitForCode(state, 5000),
  });
  await until(() => getTool("mcp__fake__ping") !== undefined);
  assert.equal(getTool("mcp__fake__authenticate"), undefined);
});
