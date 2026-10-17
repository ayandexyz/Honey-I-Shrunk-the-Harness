// =============================================================================
// Envelope → sandbox axes.
//
// The bridge from what an agent *declared* (`read:`/`write:`/`network:`) to
// what bubblewrap can actually mount. Mount boundaries are directories or
// files, not globs, so each root contributes its static prefix and anything
// with structure after that prefix is refused: a writable root the planner
// cannot represent exactly must fail closed, never be widened to its parent
// directory (spec 2026-09-27 §5.5).
//
// Reads are deliberately not confined here — a shell can read everything the
// read-only `/` bind exposes. The read axis is enforced per tool call
// (`envelopeDecision`); the mount plan exists to bound *writes* and the
// network.
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentEnvelope } from "../agent/definitions/types.js";
import { resolveOperations } from "../permission/envelope.js";
import { isWithin } from "./env.js";
import type { SandboxAxes } from "./plan.js";

export type AxesVerdict =
  | { ok: true; axes: SandboxAxes }
  | { ok: false; reason: string };

type Mount = { ok: true; path: string } | { ok: false; reason: string };

/**
 * The mount path for one envelope root, or why it cannot be one.
 *
 * The grammar is the path-rule grammar `matchPath` already uses: `//abs`,
 * `~/`, `./rel`, bare = project-relative, gitignore-style globs.
 */
function mountFor(root: string, projectRoot: string, home: string): Mount {
  const raw = root.trim();
  if (raw === "") return { ok: false, reason: "the root is empty" };
  if (raw === "**") return { ok: true, path: projectRoot };

  let base: string;
  if (raw.startsWith("//")) base = `/${raw.slice(2)}`;
  else if (raw === "~") base = home;
  else if (raw.startsWith("~/")) base = path.join(home, raw.slice(2));
  else if (raw.startsWith("./")) base = path.join(projectRoot, raw.slice(2));
  else if (raw.startsWith("/"))
    return {
      ok: false,
      reason:
        "a single leading slash is refused at load, because the matcher reads it as project-relative (write // for an absolute path)",
    };
  else base = path.join(projectRoot, raw);

  // A trailing separator is the directory form of the same root.
  base = base.replace(/\/+$/, "") || "/";
  const globAt = base.search(/[*?[]/);
  const prefix =
    (globAt === -1 ? base : base.slice(0, globAt)).replace(/\/+$/, "") || "/";
  const remainder = globAt === -1 ? "" : base.slice(globAt);

  // `docs/**` is a directory plus "everything below it"; `src/*/x` is not
  // expressible as one boundary, and mounting `src` would grant more than the
  // root does.
  if (remainder !== "" && remainder !== "**" && remainder !== "/**") {
    return {
      ok: false,
      reason: `the pattern after the prefix (${remainder}) has no single mount boundary`,
    };
  }
  if (prefix === "/") {
    return { ok: false, reason: "it covers the whole filesystem" };
  }
  const parent = path.dirname(prefix);
  if (!fs.existsSync(parent)) {
    return { ok: false, reason: `its parent ${parent} does not exist` };
  }
  return { ok: true, path: prefix };
}

/** Drop roots already covered by a shallower one, so the argv stays small. */
function dedupe(roots: string[]): string[] {
  const kept: string[] = [];
  for (const root of [...new Set(roots)].sort((a, b) => a.length - b.length)) {
    if (kept.some((shallow) => isWithin(shallow, root))) continue;
    kept.push(root);
  }
  return kept;
}

/**
 * What a shell may touch under this envelope.
 *
 * Fails closed on a writable root the planner cannot mount exactly: the caller
 * denies `shell` with this reason rather than run a shell with a boundary that
 * means something else.
 */
export function envelopeAxes(
  envelope: AgentEnvelope,
  projectRoot: string,
  home = os.homedir(),
): AxesVerdict {
  if (!resolveOperations(envelope).has("shell")) {
    return { ok: false, reason: "this agent's envelope does not grant shell" };
  }

  const rwRoots: string[] = [];
  for (const root of envelope.write ?? []) {
    const mount = mountFor(root, projectRoot, home);
    if (!mount.ok) {
      return {
        ok: false,
        reason: `write root ${root} cannot be a sandbox boundary: ${mount.reason}`,
      };
    }
    if (!fs.existsSync(mount.path)) {
      return {
        ok: false,
        reason: `write root ${root} does not exist, so it cannot be mounted read-write`,
      };
    }
    rwRoots.push(fs.realpathSync(mount.path));
  }

  // A read root that is unrepresentable or absent is skipped, not refused:
  // reads are unconfined in the sandbox, so skipping removes no access and
  // refusing would deny a shell that loses nothing.
  const roRoots: string[] = [];
  for (const root of envelope.read ?? []) {
    const mount = mountFor(root, projectRoot, home);
    if (mount.ok && fs.existsSync(mount.path)) {
      roRoots.push(fs.realpathSync(mount.path));
    }
  }

  return {
    ok: true,
    axes: {
      projectRoot,
      rwRoots: dedupe(rwRoots),
      roRoots: dedupe(roRoots),
      // Only an explicit `false` unshares: the boolean narrows, never grants.
      network: envelope.network !== false,
    },
  };
}
