import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStreamRedactor,
  heldSecretPrefix,
  knownSecrets,
  redactKnownSecrets,
} from "./known-secrets.js";

function fixtureDir(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "freecode-known-secrets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({
      providers: {
        minimax: { apiKey: "sk-cp-minimax-0123456789abcdef" },
        // A placeholder, not a credential.
        "ollama-cloud": { apiKey: "xxxxx" },
      },
      current: { provider: "minimax", model: "MiniMax-M3.1-Flash" },
    }),
  );
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      anthropic: { access_token: "sk-ant-oat01-accesstoken-abc", refresh_token: "sk-ant-ort01-refresh-xyz", account_id: "acct-0000-1111-2222-3333" },
    }),
  );
  return dir;
}

// Session 8b4b7a32: `cat ~/.freecode/config.json` put the MiniMax key into the
// conversation, the session store and every later request.
test("a cat of config.json reaches the model with the key cut out", (t) => {
  const dir = fixtureDir(t);
  const secrets = knownSecrets(dir, {});
  const out = redactKnownSecrets(
    `{"providers":{"minimax":{"apiKey":"sk-cp-minimax-0123456789abcdef"}}}`,
    secrets,
  );
  assert.doesNotMatch(out, /0123456789abcdef/);
  assert.match(out, /\[redacted: config\.json providers\.minimax\.apiKey\]/);
});

test("OAuth tokens are redacted; ids, placeholders and model names are not", (t) => {
  const dir = fixtureDir(t);
  const labels = knownSecrets(dir, {}).map((s) => s.label).sort();
  assert.deepEqual(labels, [
    "auth.json anthropic.access_token",
    "auth.json anthropic.refresh_token",
    "config.json providers.minimax.apiKey",
  ]);
});

test("key-shaped environment variables are redacted, other ones are not", () => {
  const secrets = knownSecrets("/nonexistent", {
    MINIMAX_API_KEY: "env-minimax-key-0123456789",
    GITHUB_TOKEN: "ghp_0123456789abcdefghij",
    HOME: "/home/someone-with-a-long-path",
  });
  assert.deepEqual(secrets.map((s) => s.label).sort(), ["$GITHUB_TOKEN", "$MINIMAX_API_KEY"]);
  const out = redactKnownSecrets("MINIMAX_API_KEY=env-minimax-key-0123456789\nHOME=/home/someone-with-a-long-path", secrets);
  assert.match(out, /MINIMAX_API_KEY=\[redacted: \$MINIMAX_API_KEY\]/);
  assert.match(out, /HOME=\/home\/someone-with-a-long-path/);
});

test("text without a known secret is returned unchanged", (t) => {
  const dir = fixtureDir(t);
  const text = "export const apiKey = process.env.KEY;";
  assert.equal(redactKnownSecrets(text, knownSecrets(dir, {})), text);
});

// End to end through the orchestrator, the one place every tool result
// passes: a real bash `cat` of the credential file, as the model ran it.
test("a bash cat of ~/.freecode/config.json comes back redacted", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "freecode-known-secrets-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, ".freecode"));
  writeFileSync(
    join(home, ".freecode", "config.json"),
    JSON.stringify({ providers: { minimax: { apiKey: "sk-cp-live-key-0123456789abcdef" } } }),
  );
  const { createToolOrchestrator } = await import("./orchestrator.js");
  const result = await createToolOrchestrator().execute(
    { id: "c1", tool: "bash", args: { command: "cat ~/.freecode/config.json" } } as never,
    { cwd: home, projectPath: home, sessionId: "known-secrets-test" } as never,
  );
  const seen = `${result.modelOutput ?? ""}${result.stdout ?? ""}${result.error ?? ""}`;
  assert.match(seen, /redacted: config\.json providers\.minimax\.apiKey/);
  assert.doesNotMatch(seen, /0123456789abcdef/);
});

const KEY: KnownSecretFixture = { value: "sk-cp-live-key-0123456789abcdef", label: "config.json providers.minimax.apiKey" };
type KnownSecretFixture = { value: string; label: string };

test("heldSecretPrefix holds back the start of a key, but not 1-3 chars or plain text", () => {
  assert.equal(heldSecretPrefix("export KEY=sk-cp-live-", [KEY]), "sk-cp-live-".length);
  assert.equal(heldSecretPrefix("building assets", [KEY]), 0, "a trailing 's' is not held");
  assert.equal(heldSecretPrefix("prefix sk-", [KEY]), 0, "3 chars identify nothing");
  assert.equal(heldSecretPrefix("done\n", [KEY]), 0);
});

// The live panel stream: a key printed in two chunks must never show a
// recognisable piece of itself.
test("a key split across stream chunks is redacted whole", () => {
  const live = createStreamRedactor([KEY]);
  const shown =
    live.push("KEY=sk-cp-live-") +
    live.push("key-0123456789abcdef\nnext line\n") +
    live.end();
  assert.equal(shown, "KEY=[redacted: config.json providers.minimax.apiKey]\nnext line\n");
  const partial = createStreamRedactor([KEY]);
  assert.equal(partial.push("KEY=sk-cp-live-"), "KEY=", "the key's start waits for the rest");
});

// `bashoutput` and the `/shells` panel both read through readFrom.
test("a background shell's reads redact a key printed in two parts", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "freecode-known-secrets-shell-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, ".freecode"));
  writeFileSync(
    join(home, ".freecode", "config.json"),
    JSON.stringify({ providers: { minimax: { apiKey: KEY.value } } }),
  );
  const { ShellRegistry } = await import("./shells/registry.js");
  const registry = new ShellRegistry();
  t.after(() => registry.killAll());
  const shell = registry.start({
    command: "printf 'KEY=sk-cp-live-'; sleep 1; printf 'key-0123456789abcdef\\n'",
    cwd: home,
  });
  await new Promise((r) => setTimeout(r, 400));
  const early = registry.readForModel(shell.id);
  assert.equal(early.status, "running");
  assert.equal(early.text, "KEY=", "the first half is held, not shown");
  while (registry.get(shell.id)?.status === "running") await new Promise((r) => setTimeout(r, 20));
  const late = registry.readForModel(shell.id);
  assert.equal(late.text, "[redacted: config.json providers.minimax.apiKey]\n");
});

// The foreground 5-line preview streamed while a command runs.
test("the live tail of a running bash call never shows the key", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "freecode-known-secrets-tail-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, ".freecode"));
  writeFileSync(
    join(home, ".freecode", "config.json"),
    JSON.stringify({ providers: { minimax: { apiKey: KEY.value } } }),
  );
  const { bus } = await import("../bus/index.js");
  const tails: string[] = [];
  const unsubscribe = bus.subscribe("stream", (e) => {
    const event = (e as { event: { type: string; content?: string } }).event;
    if (event.type === "tool_output" && event.content) tails.push(event.content);
  });
  t.after(unsubscribe);
  const { createToolOrchestrator } = await import("./orchestrator.js");
  await createToolOrchestrator().execute(
    {
      id: "tail-1",
      tool: "bash",
      args: { command: "printf 'KEY=sk-cp-live-'; sleep 0.6; printf 'key-0123456789abcdef\\n'; sleep 0.6" },
    } as never,
    { cwd: home, projectPath: home, sessionId: "known-secrets-tail", toolCallId: "tail-1" } as never,
  );
  assert.ok(tails.length > 0, "the tail streamed");
  for (const tail of tails) {
    assert.doesNotMatch(tail, /sk-cp-live|0123456789abcdef/, `leaked in: ${tail}`);
  }
  assert.ok(tails.some((tail) => /\[redacted: config\.json providers\.minimax\.apiKey\]/.test(tail)));
});
