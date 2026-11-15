// `EvalCase.mcpServers` fixtures: a needs-auth server offers only its
// `authenticate` tool, that tool returns a real authorization URL, and teardown
// leaves nothing behind — no tool, no waiting sign-in, nothing in mcp-auth.json.
// HOME is a temp dir so the store under test is never the operator's.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "eval-mcp-fixture-"));
process.env.HOME = home;
process.env.FREECODE_MCP_CLAUDE_CODE = "0";

const { startMcpFixtures } = await import("./mcp-fixture.js");
const { getTool } = await import("../tools/index.js");
const { MCP_AUTH_FILE } = await import("../mcp/oauth/store.js");

test("a needs-auth fixture offers authenticate, returns a URL, and tears down clean", async () => {
  assert.ok(MCP_AUTH_FILE.startsWith(home));
  const fixtures = await startMcpFixtures([{ name: "tracker", kind: "needs-auth" }]);
  try {
    assert.ok(getTool("mcp__tracker__authenticate"));
    const result = await getTool("mcp__tracker__authenticate")!.execute({}, { cwd: home });
    assert.equal(result.success, true);
    const output = (result as { result: { output: string } }).result.output;
    assert.match(output, /http:\/\/127\.0\.0\.1:\d+\/authorize\?/);
    // The waiting sign-in stored a client registration...
    assert.match(fs.readFileSync(MCP_AUTH_FILE, "utf-8"), /tracker\|/);
  } finally {
    await fixtures.stop();
  }
  // ...which teardown removes, along with the tool.
  assert.equal(getTool("mcp__tracker__authenticate"), undefined);
  assert.doesNotMatch(fs.readFileSync(MCP_AUTH_FILE, "utf-8"), /tracker\|/);
});
