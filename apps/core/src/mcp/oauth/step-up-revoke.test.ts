// MCP OAuth Phase 3 (spec 2026-11-15-mcp-oauth): a server asking for more
// scope gets it on the next sign-in, on top of what was granted; logout
// revokes at the server (RFC 7009) when it can.

import test from "node:test";
import assert from "node:assert/strict";
import { createAuthFetch, McpNeedsAuthError } from "./auth-fetch.js";
import { browser, remote, startFake, tmpFile } from "./fake-oauth-server.test.js";
import { loginMcpServer, mergeScopes } from "./login.js";
import { revokeMcpTokens } from "./revoke.js";
import { readMcpAuth, updateMcpAuth } from "./store.js";

const signIn = (fake: Awaited<ReturnType<typeof startFake>>, file: string) =>
  loginMcpServer({
    server: remote(fake),
    file,
    onAuthorizationUrl: browser,
    waitForCode: (callback, state) => callback!.waitForCode(state, 5000),
  });

test("mergeScopes keeps each scope once, in order, and is undefined when empty", () => {
  assert.equal(mergeScopes("a b", undefined, "b c"), "a b c");
  assert.equal(mergeScopes(undefined, "  "), undefined);
});

test("insufficient_scope is recorded, and the next sign-in asks for granted + new scope", async () => {
  const fake = await startFake();
  const file = tmpFile();
  try {
    await signIn(fake, file);
    assert.equal(readMcpAuth("fake", fake.mcpUrl, file)?.tokens?.scope, "mcp:connect");

    const authFetch = createAuthFetch({
      name: "fake",
      url: fake.mcpUrl,
      file,
      fetchFn: async () =>
        new Response(null, {
          status: 403,
          headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="files:write"' },
        }),
    });
    await assert.rejects(authFetch(fake.mcpUrl), (err) =>
      err instanceof McpNeedsAuthError && /files:write/.test(err.reason),
    );
    assert.equal(readMcpAuth("fake", fake.mcpUrl, file)?.stepUpScope, "files:write");

    await signIn(fake, file);
    // The challenge listed only the missing scope; the request keeps the old one.
    assert.equal(fake.authorizeScopes.at(-1), "mcp:connect files:write");
    assert.equal(readMcpAuth("fake", fake.mcpUrl, file)?.stepUpScope, undefined, "a sign-in clears it");
  } finally {
    await fake.close();
  }
});

test("a sign-in that fails keeps the pending step-up for the next try", async () => {
  const fake = await startFake();
  const file = tmpFile();
  try {
    await signIn(fake, file);
    updateMcpAuth("fake", fake.mcpUrl, (e) => ({ ...e, stepUpScope: "files:write" }), file);
    await assert.rejects(
      loginMcpServer({
        server: remote(fake),
        file,
        onAuthorizationUrl: () => undefined,
        waitForCode: async () => {
          throw new Error("user closed the browser");
        },
      }),
    );
    assert.equal(readMcpAuth("fake", fake.mcpUrl, file)?.stepUpScope, "files:write");
  } finally {
    await fake.close();
  }
});

test("logout revokes the refresh token, then the access token", async () => {
  const fake = await startFake({ revocation: true });
  const file = tmpFile();
  try {
    await signIn(fake, file);
    assert.equal(await revokeMcpTokens({ name: "fake", url: fake.mcpUrl, file }), "revoked");
    assert.deepEqual(fake.revoked, [
      { token: "r1", hint: "refresh_token" },
      { token: "a1", hint: "access_token" },
    ]);
  } finally {
    await fake.close();
  }
});

test("a server without a revocation endpoint is reported, not failed", async () => {
  const fake = await startFake();
  const file = tmpFile();
  try {
    await signIn(fake, file);
    assert.equal(await revokeMcpTokens({ name: "fake", url: fake.mcpUrl, file }), "unsupported");
    assert.equal(
      await revokeMcpTokens({ name: "other", url: fake.mcpUrl, file }),
      "nothing-to-revoke",
    );
  } finally {
    await fake.close();
  }
});
