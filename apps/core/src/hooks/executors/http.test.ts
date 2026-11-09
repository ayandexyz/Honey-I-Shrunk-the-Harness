// =============================================================================
// HTTP executor contract — POST the event document, read the reply the way a
// command hook's stdout is read. Failures never block: a supervisor that went
// away must not stall or veto the agent.
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { executeHttpHook } from "./http.js";

interface Seen {
  method?: string;
  headers?: IncomingHttpHeaders;
  body?: string;
}

async function serve(
  reply: (seen: Seen) => { status?: number; body?: string; delayMs?: number },
): Promise<{ url: string; seen: Seen; close: () => Promise<void> }> {
  const seen: Seen = {};
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.method = req.method;
      seen.headers = req.headers;
      seen.body = body;
      const r = reply(seen);
      setTimeout(() => {
        res.writeHead(r.status ?? 200, { "content-type": "application/json" });
        res.end(r.body ?? "");
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks/s1`,
    seen,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

test("posts the event document as JSON", async () => {
  const srv = await serve(() => ({}));
  try {
    const result = await executeHttpHook(
      { url: srv.url },
      { hook_event_name: "Stop", session_id: "s1" },
    );
    assert.equal(result.success, true);
    assert.equal(srv.seen.method, "POST");
    assert.equal(srv.seen.headers?.["content-type"], "application/json");
    assert.deepEqual(JSON.parse(srv.seen.body ?? ""), {
      hook_event_name: "Stop",
      session_id: "s1",
    });
  } finally {
    await srv.close();
  }
});

test("a 2xx reply is read like a command hook's stdout", async () => {
  const srv = await serve(() => ({
    body: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    }),
  }));
  try {
    const result = await executeHttpHook({ url: srv.url }, {});
    assert.equal(result.success, true);
    assert.equal(result.permissionDecision, "allow");
  } finally {
    await srv.close();
  }
});

test("headers interpolate only the variables allowedEnvVars names", async () => {
  const srv = await serve(() => ({}));
  try {
    await executeHttpHook(
      {
        url: srv.url,
        headers: {
          "X-Launch": "$LAUNCH_ID",
          "X-Braced": "id-${LAUNCH_ID}",
          "X-Secret": "$SECRET_TOKEN",
        },
        allowedEnvVars: ["LAUNCH_ID"],
      },
      {},
      { env: { LAUNCH_ID: "L42", SECRET_TOKEN: "hunter2" } },
    );
    assert.equal(srv.seen.headers?.["x-launch"], "L42");
    assert.equal(srv.seen.headers?.["x-braced"], "id-L42");
    assert.equal(srv.seen.headers?.["x-secret"], "");
  } finally {
    await srv.close();
  }
});

test("a non-2xx reply is a non-blocking error", async () => {
  const srv = await serve(() => ({
    status: 500,
    body: JSON.stringify({ decision: "block", reason: "ignored" }),
  }));
  try {
    const result = await executeHttpHook({ url: srv.url }, {});
    assert.equal(result.success, false);
    assert.equal(result.blocked, false);
    assert.match(result.error ?? "", /500/);
  } finally {
    await srv.close();
  }
});

test("an unreachable endpoint is a non-blocking error", async () => {
  const srv = await serve(() => ({}));
  const url = srv.url;
  await srv.close();
  const result = await executeHttpHook({ url }, {});
  assert.equal(result.success, false);
  assert.equal(result.blocked, false);
});

test("a reply slower than the timeout is a non-blocking error", async () => {
  const srv = await serve(() => ({ delayMs: 500 }));
  try {
    const result = await executeHttpHook({ url: srv.url }, {}, { timeout: 50 });
    assert.equal(result.success, false);
    assert.equal(result.blocked, false);
    assert.match(result.error ?? "", /timed out/);
  } finally {
    await srv.close();
  }
});
