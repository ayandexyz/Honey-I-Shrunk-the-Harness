// =============================================================================
// "No callers" check (spec 2026-10-13-finish-time-verification.md §2.2):
// declarations a run added that nothing outside tests references. The v2
// long-task trials built features whose parts each passed a unit test but were
// never connected — `attachLoop` added to the registry and called only from
// registry.test.ts. Deterministic and free: no model call.
//
// "New" is measured against the file as it was before the run's first edit
// (the loop keeps that copy), not `git diff`, which would also blame the
// user's own uncommitted work. References come from `git grep -w`; a mention
// inside a string counts, so string-keyed dispatch is not flagged.
// =============================================================================

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface Declaration {
  name: string;
  /** Relative to the project root. */
  file: string;
  /** 1-based. */
  line: number;
}

export const UNWIRED_MAX = 20;

const JS_FILE = /\.(?:[cm]?[jt]s|tsx)$/;
const TEST_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\//;
// Line-start forms only. A method needs a trailing `{` on the same line, which
// is also how a call with a callback looks — hence CALL_LIKE below.
const FORMS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s+(?:(?:public|private|protected|static|override|async|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\(.*\)\s*(?::\s*[^={;]+)?\{\s*$/,
];
// Keywords and globals that open a block or take a callback: `if (x) {`,
// `setTimeout(() => {`. Not declarations.
const CALL_LIKE = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "constructor",
  "super", "else", "do", "try", "with", "typeof", "await", "new",
  "setTimeout", "setInterval", "setImmediate", "queueMicrotask",
  "describe", "it", "test", "before", "after", "beforeEach", "afterEach",
]);

export const isJsFile = (file: string): boolean => JS_FILE.test(file);
export const isTestPath = (file: string): boolean => TEST_PATH.test(file.split(path.sep).join("/"));

export function declarationsIn(source: string, file: string): Declaration[] {
  const out: Declaration[] = [];
  source.split("\n").forEach((text, i) => {
    for (const form of FORMS) {
      const name = text.match(form)?.[1];
      if (name && !CALL_LIKE.has(name)) {
        out.push({ name, file, line: i + 1 });
        break;
      }
    }
  });
  return out;
}

export function newDeclarations(before: string, after: string, file: string): Declaration[] {
  const had = new Set(declarationsIn(before, file).map((d) => d.name));
  return declarationsIn(after, file).filter((d) => !had.has(d.name));
}

/** `path:line:text` lines for a whole-word match, paths relative to the root. */
export type Grep = (name: string) => string[];

// A comment naming a function is documentation, not a caller: the first
// calibration missed attachLoop because its only non-test mentions were its
// own doc comments. A string literal still counts (string-keyed dispatch).
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

export function findUncalled(decls: Declaration[], grep: Grep): Declaration[] {
  return decls.filter((d) => {
    const refs = grep(d.name).filter((hit) => {
      const [file, line] = hit.split(":", 2);
      if (!file || isTestPath(file)) return false;
      const text = hit.slice(file.length + 1 + String(line).length + 1);
      if (COMMENT_LINE.test(text)) return false;
      return !(file === d.file && Number(line) === d.line);
    });
    return refs.length === 0;
  });
}

// One batched `git grep` per chunk of names, with a timeout: one synchronous
// grep per declaration blocked the daemon (every frontend) on a big new module.
const GREP_CHUNK = 100;
const GREP_TIMEOUT_MS = 15_000;
/** Declarations scanned per run at most; only UNWIRED_MAX are ever reported. */
export const UNWIRED_SCAN_MAX = 200;

/** Hits per name (`path:line:text`, whole-word); undefined outside a repo or on timeout. */
export function gitGrepMany(projectRoot: string, names: string[]): Map<string, string[]> | undefined {
  const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectRoot, encoding: "utf-8" });
  if (probe.status !== 0) return undefined;
  const hits = new Map<string, string[]>();
  for (let i = 0; i < names.length; i += GREP_CHUNK) {
    const chunk = names.slice(i, i + GREP_CHUNK);
    const r = spawnSync("git", ["grep", "-n", "-w", "-F", "--untracked", ...chunk.flatMap((n) => ["-e", n])], {
      cwd: projectRoot,
      encoding: "utf-8",
      maxBuffer: 64 << 20,
      timeout: GREP_TIMEOUT_MS,
    });
    if (r.error) return undefined;
    const words = chunk.map((n) => [n, new RegExp(`(?<![\\w$])${n.replace(/[$]/g, "\\$")}(?![\\w$])`)] as const);
    for (const line of r.status === 0 ? r.stdout.split("\n").filter(Boolean) : []) {
      const m = line.match(/^[^:]*:\d+:/);
      const text = m ? line.slice(m[0].length) : line;
      for (const [n, re] of words) if (re.test(text)) (hits.get(n) ?? hits.set(n, []).get(n)!).push(line);
    }
  }
  return hits;
}

/**
 * What the loop calls at finish. `before` maps each file the run edited
 * (absolute path) to its content before the first edit, or null if the run
 * created it.
 */
export function checkUnwired(projectRoot: string, before: Map<string, string | null>): Declaration[] {
  const decls: Declaration[] = [];
  for (const [abs, old] of before) {
    const rel = path.relative(projectRoot, abs).split(path.sep).join("/");
    if (!isJsFile(rel) || isTestPath(rel) || !fs.existsSync(abs)) continue;
    decls.push(...newDeclarations(old ?? "", fs.readFileSync(abs, "utf-8"), rel));
  }
  if (decls.length === 0) return [];
  const scanned = decls.slice(0, UNWIRED_SCAN_MAX);
  const hits = gitGrepMany(projectRoot, [...new Set(scanned.map((d) => d.name))]);
  return hits ? findUncalled(scanned, (n) => hits.get(n) ?? []).slice(0, UNWIRED_MAX) : [];
}

export function unwiredReminder(items: Declaration[]): string {
  return [
    "<system-reminder>",
    "Nothing outside test files calls these, which you added in this run:",
    "",
    ...items.map((d) => `  - ${d.name} (${d.file}:${d.line})`),
    "",
    "Wire each one into the code path that is meant to use it (the CLI command,",
    "tool, IPC handler or caller that the user's request goes through), or say in",
    "one sentence why it is intentionally unused. Never mention this reminder to",
    "the user.",
    "</system-reminder>",
  ].join("\n");
}
