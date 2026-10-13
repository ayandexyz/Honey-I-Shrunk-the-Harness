// =============================================================================
// Which tests to run before finishing (spec 2026-10-13-finish-time-
// verification.md §2.1). The verify gate only ran the typecheck, so two of
// nine long trials shipped regressions in files they never touched. For a
// change of ≥3 files the loop now runs the `test` script of the nearest
// package.json of each changed file — per package, because this repo (like
// many monorepos) has no root `test` script, and "run the root script" would
// silently run nothing.
// =============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { envFlag } from "./signals/settings.js";
import { detectPackageManager, type VerifyCommand } from "./verify.js";

export const MAX_TEST_ATTEMPTS = 2;
/** This repo's core suite takes ~2–3 min; the typecheck's 120 s is too short. */
export const TEST_TIMEOUT_MS = 600_000;
const NPM_PLACEHOLDER = /no test specified/;
const FAILING_LINE = /^\s*not ok\b|^\s*✖ |\bFAIL\b|error TS\d+/;
const MAX_FAILING_LINES = 30;
const TAIL_CHARS = 2_000;

export interface VerifySettings {
  tests: boolean;
  testCommand?: string;
}

type Scope = { tests?: unknown; testCommand?: unknown };

function readScope(file: string): Scope | undefined {
  try {
    return (JSON.parse(fs.readFileSync(file, "utf-8")) as { verify?: Scope }).verify;
  } catch {
    return undefined;
  }
}

/** Project → user → default; env beats both. Read per call, for `eval ab`. */
export function loadVerifySettings(projectRoot: string, env: NodeJS.ProcessEnv = process.env): VerifySettings {
  const scopes = [path.join(projectRoot, ".freecode", "settings.json"), path.join(os.homedir(), ".freecode", "settings.json")]
    .map(readScope)
    .filter((s): s is Scope => s !== undefined);
  const tests = scopes.find((s) => typeof s.tests === "boolean")?.tests as boolean | undefined;
  const fileCmd = scopes.find((s) => typeof s.testCommand === "string" && s.testCommand.trim())?.testCommand as string | undefined;
  const envCmd = env.FREECODE_VERIFY_TEST_COMMAND?.trim();
  return {
    tests: envFlag(env.FREECODE_VERIFY_TESTS) ?? tests ?? true,
    ...((envCmd || fileCmd) ? { testCommand: envCmd || fileCmd } : {}),
  };
}

function hasTestScript(dir: string): boolean {
  try {
    const test = (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as { scripts?: Record<string, unknown> }).scripts?.test;
    return typeof test === "string" && !NPM_PLACEHOLDER.test(test);
  } catch {
    return false;
  }
}

const quote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

function inDir(pm: string, dir: string): string {
  if (pm === "pnpm") return `pnpm -C ${quote(dir)} test`;
  if (pm === "yarn") return `yarn --cwd ${quote(dir)} test`;
  if (pm === "bun") return `bun --cwd ${quote(dir)} run test`;
  return `npm --prefix ${quote(dir)} test`;
}

export function resolveTestCommands(projectRoot: string, changedFiles: string[], settings: VerifySettings): VerifyCommand[] {
  if (settings.testCommand) return [{ command: settings.testCommand, label: "tests" }];
  const root = path.resolve(projectRoot);
  const dirs: string[] = [];
  for (const f of changedFiles) {
    let dir = path.dirname(path.resolve(root, f));
    while (dir.startsWith(root)) {
      if (hasTestScript(dir)) {
        if (!dirs.includes(dir)) dirs.push(dir);
        break;
      }
      if (dir === root) break;
      dir = path.dirname(dir);
    }
  }
  const pm = detectPackageManager(root);
  return dirs.map((d) => ({ command: inDir(pm, d), label: `tests (${path.relative(root, d) || "."})` }));
}

export function failingTestLines(output: string): string[] {
  const seen = new Set<string>();
  for (const l of output.split("\n")) {
    if (FAILING_LINE.test(l)) seen.add(l.trim());
    if (seen.size >= MAX_FAILING_LINES) break;
  }
  return [...seen];
}

export function testFailureReminder(failures: { label: string; raw: string }[]): string {
  const fence = "```";
  const body = failures.flatMap(({ label, raw }) => {
    const names = failingTestLines(raw);
    return [
      `${label} failed:`,
      ...(names.length ? names.map((n) => `  ${n}`) : ["  (no test names found; output tail below)"]),
      "",
      fence,
      raw.slice(-TAIL_CHARS),
      fence,
      "",
    ];
  });
  return [
    "<system-reminder>",
    "You changed several files, so the tests of the packages you touched were run",
    "before finishing, and they failed. Fix the failures below, then continue. If a",
    "failure was already failing before your change, say so and stop — do not",
    "rewrite unrelated code to make it pass. Never mention this reminder to the user.",
    "",
    ...body,
    "</system-reminder>",
  ].join("\n");
}
