// =============================================================================
// Agent definitions — `<scope>/agents/*.md` role files for the `agent` tool.
//
// Claude Code's format, so an existing `.claude/agents/*.md` loads unchanged:
//
//   ---
//   name: scout
//   description: Read-only reconnaissance before anyone edits.
//   tools: Read, Grep, Glob          # optional allowlist (comma list or YAML list)
//   model: inherit                   # optional: inherit | provider/model
//   mode: explore                    # optional FreeCode extension: explore | build
//   envelope:                        # optional FreeCode extension: capability ceiling
//     operations: [file.read]        #   spec 2026-09-27-agent-control-and-definitions.md §5.3
//     read: ["**"]
//   ---
//   System prompt for the agent.
//
// Scopes, later wins on a name clash (spec 2026-09-27-agent-control-and-
// definitions.md §2.3): built-in → ~/.claude/agents → ~/.freecode/agents →
// <project>/.claude/agents → <project>/.freecode/agents.
//
// Synchronous and uncached on purpose: the roster is rendered into the system
// prompt, which is compiled per turn from disk like CLAUDE.md, and these
// directories hold a handful of small files.
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logger } from "../../utils/logger.js";
import { BUILTIN_AGENT_DEFINITIONS } from "./builtin.js";
import { parseEnvelope } from "./envelope.js";
import type { AgentDefinition, AgentDefinitionScope, AgentEnvelope } from "./types.js";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
/** Claude Code's model aliases; they name no provider, so they mean "inherit". */
const CLAUDE_CODE_MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "fable", "inherit"]);

/** A frontmatter value: a scalar, an inline/block list, or one nested block. */
export type FrontmatterValue = string | string[] | Record<string, string | string[]>;

/** What the open top-level key turned out to be, decided by its first child. */
type Block = "undecided" | "set" | "list" | "map";

/**
 * `key: value`, `key: [a, b]`, `key:` followed by `- item` lines, and — FreeCode's
 * addition, for a definition's `envelope:` — one level of `key:` followed by
 * indented `child: value` lines. Nothing else of YAML.
 */
export function parseFrontmatter(
  text: string,
): { fields: Record<string, FrontmatterValue>; body: string } | null {
  const match = text.match(FRONTMATTER);
  if (!match) return null;
  const fields: Record<string, FrontmatterValue> = {};
  // A bare `key:` is a list in Claude Code's agent files and a map in ours, and
  // only the next indented line says which — so the kind stays undecided until
  // one arrives.
  let open: string | undefined;
  let block: Block = "undecided";
  // The open child of a map key and the indent it sits at. A `- item` belongs to
  // it only while it is indented deeper, and a sibling `child: value` at its own
  // indent closes it — without the indent, every sibling after a block-form child
  // is swallowed and that child's items absorb the next axis.
  let child: string | undefined;
  let childIndent = -1;

  for (const raw of match[1]!.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue; // a blank line never closes a block
    const indent = line.match(/^\s*/)![0]!.length;
    const item = line.match(/^\s*-\s+(.+)$/);
    const kv = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);

    if (indent > 0) {
      if (item) {
        if (open === undefined) continue;
        if (child !== undefined && indent > childIndent) {
          (fields[open] as Record<string, string[]>)[child]!.push(unquote(item[1]!));
        } else if (block === "undecided" || block === "list") {
          // A block list keeps taking items: "skills:" then "- x", "- y".
          block = "list";
          (fields[open] as string[]).push(unquote(item[1]!));
        }
        continue;
      }
      if (!kv) continue;
      const [, key, value] = kv as unknown as [string, string, string];
      if (open === undefined) continue;
      if (child !== undefined && indent > childIndent) continue; // deeper still belongs to the child
      if (block === "undecided") {
        block = "map";
        fields[open] = {};
      }
      if (block !== "map") continue; // an item list cannot take `key: value` lines
      const map = fields[open] as Record<string, string | string[]>;
      child = undefined;
      if (value === "") {
        map[key] = [];
        child = key;
        childIndent = indent;
      } else {
        map[key] = inlineList(value) ?? unquote(value);
      }
      continue;
    }

    if (!kv) continue;
    const [, key, value] = kv as unknown as [string, string, string];
    open = key;
    child = undefined;
    if (value === "") {
      fields[key] = [];
      block = "undecided";
    } else {
      const list = inlineList(value);
      fields[key] = list ?? unquote(value);
      // A value already read takes no indented children, as before.
      block = "set";
    }
  }
  return { fields, body: match[2]!.trim() };
}

/** `[a, b]` → a list, a scalar → undefined. Split on commas, as before. */
function inlineList(value: string): string[] | undefined {
  return value.startsWith("[") && value.endsWith("]")
    ? value
        .slice(1, -1)
        .split(",")
        .map(unquote)
        .filter(Boolean)
    : undefined;
}

function unquote(s: string): string {
  return s.trim().replace(/^["']|["']$/g, "");
}

function asList(v: FrontmatterValue | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  // A nested block where a list belongs is malformed, not empty: [] here makes
  // the caller refuse the file instead of reading it as "no allowlist".
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return list.map((t) => t.trim()).filter(Boolean);
}

function asString(v: FrontmatterValue | undefined): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * One file → one definition, or null with a warning. `knownTools` maps the
 * lowercased names FreeCode registers; Claude Code's capitalised names
 * (`Read`, `Grep`) resolve through it.
 */
export function parseAgentFile(
  text: string,
  file: string,
  scope: AgentDefinitionScope,
  knownTools: ReadonlySet<string>,
): AgentDefinition | null {
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    logger.warn(`[agents] ${file}: no frontmatter, skipped`);
    return null;
  }
  const { fields, body } = parsed;
  const name = asString(fields.name) ?? path.basename(file, ".md");
  const description = asString(fields.description);
  if (!NAME.test(name) || !description) {
    logger.warn(`[agents] ${file}: needs a name (letters, digits, - or _) and a description, skipped`);
    return null;
  }

  let tools: string[] | undefined;
  const listed = asList(fields.tools);
  if (listed) {
    tools = [...new Set(listed.map((t) => t.toLowerCase()).filter((t) => knownTools.has(t)))];
    const unknown = listed.filter((t) => !knownTools.has(t.toLowerCase()));
    if (unknown.length) logger.debug(`[agents] ${file}: ignoring unknown tools ${unknown.join(", ")}`);
    if (tools.length === 0) {
      logger.warn(`[agents] ${file}: none of its tools exist here (${listed.join(", ")}), skipped`);
      return null;
    }
  }

  const rawModel = asString(fields.model);
  const model =
    !rawModel || CLAUDE_CODE_MODEL_ALIASES.has(rawModel.toLowerCase()) ? undefined : rawModel;

  const rawMode = asString(fields.mode)?.toLowerCase();
  if (rawMode && rawMode !== "explore" && rawMode !== "build") {
    logger.warn(`[agents] ${file}: mode must be explore or build, skipped`);
    return null;
  }
  // No mode: a file that lists a writing tool means to write (Claude Code has
  // no mode field, and its `tools: Edit, Write` would be dead in explore).
  const writes = tools?.some((t) => t === "write" || t === "edit" || t === "bash") ?? false;
  const mode = (rawMode as "explore" | "build" | undefined) ?? (writes ? "build" : "explore");

  // A definition whose ceiling does not validate is refused outright — loading
  // it without the envelope would silently grant the mode's full set.
  const rawEnvelope = fields.envelope;
  let envelope: AgentEnvelope | undefined;
  if (rawEnvelope !== undefined) {
    const parsed = parseEnvelope(rawEnvelope, knownTools);
    if ("error" in parsed) {
      logger.warn(`[agents] ${file}: ${parsed.error}, skipped`);
      return null;
    }
    envelope = parsed;
  }

  return { name, description, prompt: body, tools, model, mode, scope, location: file, envelope };
}

function readScope(
  dir: string,
  scope: AgentDefinitionScope,
  knownTools: ReadonlySet<string>,
): AgentDefinition[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: AgentDefinition[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      const def = parseAgentFile(fs.readFileSync(file, "utf-8"), file, scope, knownTools);
      if (def) out.push(def);
    } catch (error) {
      logger.warn(`[agents] ${file}: unreadable (${String(error)}), skipped`);
    }
  }
  return out;
}

export interface LoadAgentsOptions {
  projectPath: string;
  knownTools: ReadonlySet<string>;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The effective roster, sorted by name. `shadowed` lists the definitions a
 * later scope replaced, for `freecode agents list`.
 */
export function loadAgentDefinitions(opts: LoadAgentsOptions): {
  definitions: AgentDefinition[];
  shadowed: AgentDefinition[];
} {
  const home = opts.homeDir ?? os.homedir();
  const env = opts.env ?? process.env;
  const claudeCode = env.FREECODE_CLAUDE_CODE_AGENTS !== "0";
  const layers: AgentDefinition[][] = [
    BUILTIN_AGENT_DEFINITIONS,
    claudeCode ? readScope(path.join(home, ".claude", "agents"), "claude-code-user", opts.knownTools) : [],
    readScope(path.join(home, ".freecode", "agents"), "user", opts.knownTools),
    claudeCode
      ? readScope(path.join(opts.projectPath, ".claude", "agents"), "claude-code-project", opts.knownTools)
      : [],
    readScope(path.join(opts.projectPath, ".freecode", "agents"), "project", opts.knownTools),
  ];
  const byName = new Map<string, AgentDefinition>();
  const shadowed: AgentDefinition[] = [];
  for (const layer of layers) {
    for (const def of layer) {
      const prev = byName.get(def.name);
      if (prev) shadowed.push(prev);
      byName.set(def.name, def);
    }
  }
  const definitions = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { definitions, shadowed };
}
