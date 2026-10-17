// =============================================================================
// Project instructions loader
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
const SEPARATOR = "\n\n";
const IMPORT_RE = /^\s*@import\s+(.+?)\s*$/gm;
const MAX_IMPORT_DEPTH = 16;
const MAX_IMPORTED_FILES = 64;
const MAX_TOTAL_BYTES = 1_000_000;

export interface InstructionSource {
  path: string;
  kind: "global" | "hierarchy" | "import" | "scoped-rule";
  precedence: number;
  scope?: string[];
  bytes: number;
  tokens: number;
}

export interface InstructionsResult { text: string; sources: InstructionSource[] }
interface RawSource { path: string; kind: InstructionSource["kind"]; precedence: number; scope?: string[]; content: string }

function normalize(filePath: string): string { return path.resolve(filePath); }
function isWithin(filePath: string, root: string): boolean {
  const relative = path.relative(normalize(root), normalize(filePath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
function readFirstMatch(dir: string): { path: string; content: string } | undefined {
  for (const name of INSTRUCTION_FILES) {
    const filePath = path.join(dir, name);
    try {
      const content = fs.readFileSync(filePath, "utf8").trim();
      if (content) return { path: filePath, content };
    } catch { /* missing or unreadable */ }
  }
  return undefined;
}
function repositoryRoot(projectPath: string): string {
  const original = normalize(projectPath);
  let current = original;
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return original;
    current = parent;
  }
}
function globToRegExp(glob: string): RegExp {
  const normalized = glob.replaceAll("\\", "/").replace(/^\.\//, "");
  let source = "";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!;
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        i++;
        if (normalized[i + 1] === "/") { i++; source += "(?:.*/)?"; }
        else source += ".*";
      }
      else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`);
}
function parseScopedRule(content: string): { globs: string[]; body: string } | undefined {
  if (!content.startsWith("---\n")) return undefined;
  const end = content.indexOf("\n---", 4);
  if (end < 0) return undefined;
  const globs: string[] = [];
  for (const line of content.slice(4, end).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:-\s*)?globs:\s*(.*)$/);
    if (!match) continue;
    const value = match[1]!.trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      globs.push(...value.slice(1, -1).split(",").map((item) => item.trim().replace(/^['\"]|['\"]$/g, "")).filter(Boolean));
    } else if (value) globs.push(value.replace(/^['\"]|['\"]$/g, ""));
  }
  const body = content.slice(end + 4).trim();
  return globs.length > 0 && body ? { globs, body } : undefined;
}
function matchesScope(globs: string[], scopePaths: readonly string[], projectPath: string): boolean {
  return scopePaths.some((filePath) => {
    const relative = path.isAbsolute(filePath) ? path.relative(projectPath, filePath) : filePath;
    const candidate = relative.replaceAll(path.sep, "/");
    return globs.some((glob) => globToRegExp(glob).test(candidate));
  });
}
function expandImports(source: RawSource, policyRoot: string, state: { seen: Set<string>; count: number; bytes: number }, depth: number): RawSource[] {
  if (depth > MAX_IMPORT_DEPTH) return [source];
  const output: RawSource[] = [];
  let last = 0;
  for (const match of source.content.matchAll(IMPORT_RE)) {
    output.push({ ...source, content: source.content.slice(last, match.index) });
    last = (match.index ?? 0) + match[0].length;
    const lexical = normalize(path.resolve(path.dirname(source.path), match[1]!.trim()));
    let imported: string;
    try { imported = fs.realpathSync(lexical); } catch { continue; }
    if (!isWithin(imported, policyRoot) || state.seen.has(imported) || state.count >= MAX_IMPORTED_FILES) continue;
    try {
      const content = fs.readFileSync(imported, "utf8").trim();
      const bytes = Buffer.byteLength(content, "utf8");
      if (state.bytes + bytes > MAX_TOTAL_BYTES) continue;
      state.seen.add(imported); state.count++; state.bytes += bytes;
      output.push(...expandImports({ path: imported, kind: "import", precedence: source.precedence, content }, policyRoot, state, depth + 1));
    } catch { /* missing, unreadable, or a directory */ }
  }
  output.push({ ...source, content: source.content.slice(last) });
  return output.filter((item) => item.content.trim());
}
function loadRules(projectPath: string, scopePaths: readonly string[], precedence: number): RawSource[] {
  const dir = path.join(projectPath, ".freecode", "rules");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    try {
      const rule = parseScopedRule(fs.readFileSync(filePath, "utf8").trim());
      if (!rule || !matchesScope(rule.globs, scopePaths, projectPath)) return [];
      return [{ path: filePath, kind: "scoped-rule" as const, precedence, scope: rule.globs, content: rule.body }];
    } catch { return []; }
  });
}
function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }

/** Stable session scope used by the prompt and `/context` rule selection. */
export function collectScopePaths(projectPath: string): string[] {
  const ignored = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo"]);
  const result: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(filePath);
      else if (entry.isFile()) result.push(filePath);
    }
  };
  visit(normalize(projectPath));
  return result.sort();
}

export function loadInstructions(projectPath: string, globalDir = path.join(os.homedir(), ".freecode"), scopePaths: readonly string[] = []): InstructionsResult {
  const project = normalize(projectPath);
  const repo = repositoryRoot(project);
  const sources: RawSource[] = [];
  const global = readFirstMatch(globalDir);
  if (global) sources.push({ ...global, kind: "global", precedence: 0 });
  const directories: string[] = [];
  let current = project;
  while (true) {
    directories.push(current);
    if (current === repo) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const [index, dir] of directories.reverse().entries()) {
    const found = readFirstMatch(dir);
    if (found) sources.push({ ...found, kind: "hierarchy", precedence: index + 1 });
  }
  sources.push(...loadRules(project, scopePaths, sources.length + 1));
  const state = { seen: new Set<string>(), count: 0, bytes: 0 };
  const expanded = sources.flatMap((source) =>
    expandImports(source, source.kind === "global" ? normalize(globalDir) : repo, state, 0),
  );
  return {
    text: expanded.map((source) => `Instructions from: ${source.path}\n${source.content}`).join(SEPARATOR),
    sources: expanded.map((source) => ({ path: source.path, kind: source.kind, precedence: source.precedence, scope: source.scope, bytes: Buffer.byteLength(source.content, "utf8"), tokens: estimateTokens(source.content) })),
  };
}
export function compileInstructionsSection(projectPath: string, globalDir = path.join(os.homedir(), ".freecode"), scopePaths: readonly string[] = []): string {
  return loadInstructions(projectPath, globalDir, scopePaths).text;
}
