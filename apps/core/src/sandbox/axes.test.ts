// =============================================================================
// Envelope → axes: what a declared `read:`/`write:`/`network:` set becomes as
// mount boundaries, and what is refused rather than widened.
// Spec: docs/specs/2026-09-27-agent-control-and-definitions.md §5.5, §5.9
// =============================================================================

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentEnvelope } from "../agent/definitions/types.js";
import { envelopeAxes, type AxesVerdict } from "./axes.js";

function reject(verdict: AxesVerdict): string {
  assert.equal(verdict.ok, false, "expected the axes to be refused");
  return verdict.ok ? "" : verdict.reason;
}

function accept(verdict: AxesVerdict) {
  if (!verdict.ok) throw new Error(`expected axes, got: ${verdict.reason}`);
  return verdict.axes;
}

/** A project with `docs/`, `src/`, `src/a/`, `notes.md` and `work/`. */
function fixture(): { root: string; project: string; home: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-axes-"));
  const project = path.join(root, "project");
  fs.mkdirSync(path.join(project, "docs", "guide"), { recursive: true });
  fs.mkdirSync(path.join(project, "src", "a"), { recursive: true });
  fs.writeFileSync(path.join(project, "notes.md"), "n");
  fs.mkdirSync(path.join(root, "home", "work"), { recursive: true });
  return { root, project, home: path.join(root, "home") };
}

test("a directory root contributes its static prefix", () => {
  const { root, project, home } = fixture();
  try {
    const axes = accept(
      envelopeAxes(
        { operations: ["shell", "file.read", "file.write"], read: ["src/**"], write: ["docs/**"] },
        project,
        home,
      ),
    );
    assert.deepEqual(axes.rwRoots, [fs.realpathSync(path.join(project, "docs"))]);
    assert.deepEqual(axes.roRoots, [fs.realpathSync(path.join(project, "src"))]);
    assert.equal(axes.network, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an exact file root is representable", () => {
  const { root, project, home } = fixture();
  try {
    const axes = accept(
      envelopeAxes(
        { operations: ["shell", "file.write"], write: ["notes.md"] },
        project,
        home,
      ),
    );
    assert.deepEqual(axes.rwRoots, [fs.realpathSync(path.join(project, "notes.md"))]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a home-relative root resolves under the sandbox home", () => {
  const { root, project, home } = fixture();
  try {
    const axes = accept(
      envelopeAxes(
        { operations: ["shell", "file.write"], write: ["~/work/**"] },
        project,
        home,
      ),
    );
    assert.deepEqual(axes.rwRoots, [fs.realpathSync(path.join(home, "work"))]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a glob with structure after the prefix is refused, never widened", () => {
  // Mounting `src` read-write would grant far more than `src/*/tests/**` says.
  const { root, project, home } = fixture();
  try {
    const reason = reject(
      envelopeAxes(
        { operations: ["shell", "file.write"], write: ["src/*/tests/**"] },
        project,
        home,
      ),
    );
    assert.match(reason, /write root src\/\*\/tests\/\*\* cannot be a sandbox boundary/);
    assert.match(reason, /no single mount boundary/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a whole-filesystem write root is refused", () => {
  const { root, project, home } = fixture();
  try {
    assert.match(
      reject(envelopeAxes({ operations: ["shell", "file.write"], write: ["//"] }, project, home)),
      /covers the whole filesystem/,
    );
    assert.match(
      reject(envelopeAxes({ operations: ["shell", "file.write"], write: ["//**"] }, project, home)),
      /covers the whole filesystem/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a single leading slash is refused, like the loader refuses it", () => {
  const { root, project, home } = fixture();
  try {
    assert.match(
      reject(envelopeAxes({ operations: ["shell", "file.write"], write: ["/etc/**"] }, project, home)),
      /single leading slash is refused at load/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a writable root that cannot be mounted is refused, not skipped", () => {
  const { root, project, home } = fixture();
  try {
    // The parent does not exist, so there is nothing to bind and nothing to
    // create: bounding it anywhere would be a different boundary.
    assert.match(
      reject(
        envelopeAxes({ operations: ["shell", "file.write"], write: ["missing/deep/**"] }, project, home),
      ),
      /its parent .* does not exist/,
    );
    // The parent exists but the directory itself does not: the agent may still
    // be about to create it, and the sandbox cannot grant that.
    assert.match(
      reject(
        envelopeAxes({ operations: ["shell", "file.write"], write: ["docs/new.md"] }, project, home),
      ),
      /does not exist, so it cannot be mounted read-write/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nested writable roots collapse to the shallowest", () => {
  const { root, project, home } = fixture();
  try {
    const axes = accept(
      envelopeAxes(
        { operations: ["shell", "file.write"], write: ["docs/**", "docs/guide/**"] },
        project,
        home,
      ),
    );
    assert.deepEqual(axes.rwRoots, [fs.realpathSync(path.join(project, "docs"))]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an absent read root is skipped, because reads are unconfined anyway", () => {
  const { root, project, home } = fixture();
  try {
    const axes = accept(
      envelopeAxes(
        {
          operations: ["shell", "file.read"],
          read: ["gone/**", "src/*/tests/**", "src/**"],
        },
        project,
        home,
      ),
    );
    assert.deepEqual(axes.roRoots, [fs.realpathSync(path.join(project, "src"))]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("network: false is carried through; absent or true stays shared", () => {
  const { root, project, home } = fixture();
  const envelope = (network?: boolean): AgentEnvelope => ({
    operations: ["shell"],
    ...(network === undefined ? {} : { network }),
  });
  try {
    assert.equal(accept(envelopeAxes(envelope(false), project, home)).network, false);
    assert.equal(accept(envelopeAxes(envelope(true), project, home)).network, true);
    assert.equal(accept(envelopeAxes(envelope(), project, home)).network, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an envelope that does not grant shell has no axes", () => {
  const { root, project, home } = fixture();
  try {
    assert.match(
      reject(envelopeAxes({ operations: ["file.read"], read: ["src/**"] }, project, home)),
      /does not grant shell/,
    );
    assert.match(
      reject(envelopeAxes({ operations: ["shell"], shell: false }, project, home)),
      /does not grant shell/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
