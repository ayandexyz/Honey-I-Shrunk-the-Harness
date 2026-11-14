// Measures what MCP tool schemas cost per request: connects the configured
// servers exactly as startup does, then estimates the serialized tool list with
// the same chars/4 estimator `/context` uses. One-off, read-only.
//
//   pnpm --filter @thisisayande/freecode-core exec tsx scripts/measure-mcp-tools.ts [projectDir]

import { loadMcpConfig } from "../src/mcp/config.js";
import { initMcpServers, stopMcpServers } from "../src/mcp/init.js";
import { getToolDefs } from "../src/tools/defs-cache.js";
import { estimateTokenCount } from "../src/compaction/tokens.js";
import * as os from "os";
import * as path from "path";

const projectDir = process.argv[2] ?? process.cwd();
process.chdir(projectDir);

const config = await loadMcpConfig(path.join(os.homedir(), ".freecode"), projectDir);
console.log(`configured servers: ${config.servers.map((s) => s.name).join(", ") || "(none)"}`);

await initMcpServers();

const defs = getToolDefs();
const cost = (t: (typeof defs)[number]) =>
  estimateTokenCount(t.name + t.description + JSON.stringify(t.parameters));

let builtin = 0;
let builtinCount = 0;
const perServer = new Map<string, { tools: number; tokens: number; max: number; maxName: string }>();
for (const t of defs) {
  const tokens = cost(t);
  if (!t.name.startsWith("mcp__")) {
    builtin += tokens;
    builtinCount++;
    continue;
  }
  const server = t.name.split("__")[1];
  const row = perServer.get(server) ?? { tools: 0, tokens: 0, max: 0, maxName: "" };
  row.tools++;
  row.tokens += tokens;
  if (tokens > row.max) {
    row.max = tokens;
    row.maxName = t.name;
  }
  perServer.set(server, row);
}

const mcpTotal = [...perServer.values()].reduce((a, r) => a + r.tokens, 0);
const mcpCount = [...perServer.values()].reduce((a, r) => a + r.tools, 0);
console.log(`\nbuilt-in: ${builtinCount} tools, ~${builtin} tokens`);
console.log(`MCP:      ${mcpCount} tools, ~${mcpTotal} tokens\n`);
for (const [server, r] of [...perServer].sort((a, b) => b[1].tokens - a[1].tokens)) {
  console.log(
    `  ${server.padEnd(28)} ${String(r.tools).padStart(3)} tools  ~${String(r.tokens).padStart(6)} tok   largest ${r.maxName} ~${r.max}`,
  );
}
for (const limit of [128_000, 200_000, 1_000_000]) {
  console.log(`MCP share of a ${limit / 1000}K window: ${((mcpTotal / limit) * 100).toFixed(1)}%`);
}

await stopMcpServers();
process.exit(0);
