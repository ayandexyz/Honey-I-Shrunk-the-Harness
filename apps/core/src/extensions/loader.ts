// =============================================================================
// Extension loader (spec 2026-09-20-pi-parity-plan, Phase 5).
//
// Discovery: `~/.freecode/extensions/*.{ts,js,mjs}` always; the project's
// `.freecode/extensions/` only when the project is trusted — an extension is
// arbitrary code, and cloning a repo must not run it. Trust is a global list
// (`~/.freecode/settings.json` → `extensions.trustedProjects`) or
// `FREECODE_TRUST_PROJECT_EXTENSIONS=1`. Loaded with a plain `import()`:
// tsx (dev) and bun (release binary) both resolve .ts natively, so no jiti.
//
// Reload: every registration is tracked per file and undone before the file
// is imported again (with a cache-busting query so ESM re-evaluates it).
// =============================================================================

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { buildTool } from "../tools/factory.js";
import { registerExtensionTool, unregisterExtensionTool } from "../tools/index.js";
import { claimToolReadOnly, dropToolReadOnlyClaim } from "../permission/mode-policy.js";
import { registerPromptCommand, unregisterPromptCommand } from "../commands/registry.js";
import { registerHook, unregisterHook } from "../hooks/registry.js";
import { BusEvents } from "../bus/index.js";
import { logger } from "../utils/logger.js";
import { readSettingsFile } from "../settings/load.js";
import type {
  ExtensionAPI,
  ExtensionModule,
  ExtensionToolDef,
  LoadedExtension,
} from "./types.js";

const EXTENSION_EXTS = new Set([".ts", ".js", ".mjs"]);

const loaded = new Map<string, LoadedExtension>();

export function listExtensions(): LoadedExtension[] {
  return [...loaded.values()];
}

// User scope only: a repository must not be able to vouch for itself.
function readTrustedProjects(home = os.homedir()): string[] {
  const extensions = readSettingsFile(path.join(home, ".freecode", "settings.json"))?.extensions as
    | { trustedProjects?: unknown }
    | undefined;
  const list = extensions?.trustedProjects;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
}

export function isProjectTrusted(projectPath: string, env = process.env): boolean {
  if (env.FREECODE_TRUST_PROJECT_EXTENSIONS === "1") return true;
  const resolved = path.resolve(projectPath);
  return readTrustedProjects().some((p) => path.resolve(p) === resolved);
}

function discover(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && EXTENSION_EXTS.has(path.extname(d.name)) && !d.name.endsWith(".d.ts"))
      .map((d) => path.join(dir, d.name))
      .sort();
  } catch {
    return [];
  }
}

export function extensionFiles(
  projectPath: string | undefined,
  home = os.homedir(),
): Array<{ file: string; scope: "user" | "project" }> {
  const user = discover(path.join(home, ".freecode", "extensions")).map((file) => ({
    file,
    scope: "user" as const,
  }));
  if (!projectPath) return user;
  const projectDir = path.join(projectPath, ".freecode", "extensions");
  const project = discover(projectDir);
  if (project.length > 0 && !isProjectTrusted(projectPath)) {
    logger.warn(
      `[extensions] ${project.length} project extension(s) in ${projectDir} not loaded: ` +
        `project is not trusted (add it to extensions.trustedProjects in ~/.freecode/settings.json).`,
    );
    return user;
  }
  return [...user, ...project.map((file) => ({ file, scope: "project" as const }))];
}

function unload(source: string): void {
  const prev = loaded.get(source);
  if (!prev) return;
  for (const id of prev.tools) {
    unregisterExtensionTool(id);
    dropToolReadOnlyClaim(id);
  }
  for (const name of prev.commands) unregisterPromptCommand(name);
  for (const h of prev.hooks) unregisterHook(h.event, h.name);
  loaded.delete(source);
  if (prev.tools.length > 0) BusEvents.toolsChanged([], prev.tools);
}

function makeApi(record: LoadedExtension): ExtensionAPI {
  const base = path.basename(record.source);
  return {
    source: record.source,
    scope: record.scope,
    registerTool<P>(def: ExtensionToolDef<P>) {
      const tool = buildTool<P, { output: string; title?: string }>({
        id: def.name,
        description: def.description,
        schemas: { parameters: def.parameters },
        behavior: { isConcurrencySafe: def.readOnly === true, userFacingName: def.name },
        execute: async (args, ctx) => {
          const r = await def.execute(args, ctx);
          const out = typeof r === "string" ? { output: r } : r;
          return {
            title: out.title ?? def.name,
            output: out.output,
            metadata: {},
          } as never;
        },
      });
      registerExtensionTool(tool as never);
      if (def.readOnly) claimToolReadOnly(def.name);
      record.tools.push(def.name);
      BusEvents.toolsChanged([{ id: def.name, description: def.description }], []);
    },
    registerCommand(def) {
      registerPromptCommand({
        name: def.name,
        description: def.description,
        argHint: def.argHint,
        template: (ctx) => def.prompt({ cwd: ctx.cwd, args: ctx.args }),
      });
      record.commands.push(def.name);
    },
    on(event, handler, options) {
      const name = `ext:${base}:${event}:${record.hooks.length}`;
      registerHook(
        event,
        name,
        { type: "callback", callback: async (input, context) => handler(input, context) },
        "plugin",
        { matcher: options?.matcher },
      );
      record.hooks.push({ event, name });
    },
    log(message) {
      logger.info(`[extension ${base}] ${message}`);
    },
  };
}

/** Load one file. Exposed for tests; startup goes through loadExtensions(). */
export async function loadExtensionFile(
  file: string,
  scope: "user" | "project",
): Promise<LoadedExtension> {
  unload(file);
  const record: LoadedExtension = { source: file, scope, tools: [], commands: [], hooks: [] };
  loaded.set(file, record);
  try {
    const url = `${pathToFileURL(file).href}?t=${Date.now()}`;
    const mod = (await import(url)) as { default?: ExtensionModule };
    if (typeof mod.default !== "function") {
      throw new Error("default export is not a function (api: ExtensionAPI) => void");
    }
    await mod.default(makeApi(record));
    logger.info(
      `[extensions] loaded ${path.basename(file)}: ${record.tools.length} tool(s), ` +
        `${record.commands.length} command(s), ${record.hooks.length} hook(s)`,
    );
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
    logger.warn(`[extensions] ${file} failed: ${record.error}`);
    // Partial registrations from a throwing factory are taken back out.
    const partial = { ...record };
    unload(file);
    loaded.set(file, { ...partial, tools: [], commands: [], hooks: [] });
  }
  return record;
}

/** Load (or reload) every discoverable extension. Never throws. */
export async function loadExtensions(
  projectPath: string | undefined,
): Promise<LoadedExtension[]> {
  if (process.env.FREECODE_DISABLE_EXTENSIONS === "1") return [];
  const files = extensionFiles(projectPath);
  const wanted = new Set(files.map((f) => f.file));
  for (const source of [...loaded.keys()]) if (!wanted.has(source)) unload(source);
  const results: LoadedExtension[] = [];
  for (const { file, scope } of files) results.push(await loadExtensionFile(file, scope));
  return results;
}

/** Test/reload helper: take every extension out. */
export function unloadAllExtensions(): void {
  for (const source of [...loaded.keys()]) unload(source);
}
