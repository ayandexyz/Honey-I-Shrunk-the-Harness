// =============================================================================
// Hook Settings - Load hooks from settings.json
// Scopes, lowest priority first: user (~/.freecode/settings.json) → project
// (.freecode/settings.json) → launch (FREECODE_SETTINGS: a file or inline JSON
// handed to this one process by whatever started it).
// Parse failures fail closed (invalid hooks are skipped with warnings).
// Spec: docs/specs/2026-07-31-hooks-settings-design.md
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { HookEventName, CommandHook, HttpHook } from "./types.js";
import { HOOK_EVENT_NAMES } from "./types.js";
import { registerHook, unregisterAllHooks } from "./registry.js";
import { logger } from "../utils/logger.js";

// =============================================================================
// Configuration Types
// =============================================================================

type Scope = "user" | "project" | "launch";

/**
 * Hook definition as it appears in settings.json
 */
export interface HookDefinition {
  /** Unique name for this hook within the event */
  name: string;
  /** Tool name pattern to match (e.g., "Write", "Bash", "*", "Write|Edit") */
  matcher?: string;
  /** "command" (default) runs a shell command; "http" POSTs the event to `url` */
  type: "command" | "http";
  /** Shell command to execute (command hooks) */
  command?: string;
  /** Shell to use: "bash" (default) or "powershell" */
  shell?: "bash" | "powershell";
  /** Endpoint the event document is POSTed to (http hooks) */
  url?: string;
  /** Request headers; `$NAME` interpolates only names in allowedEnvVars */
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  /** Timeout in seconds (default: 300 = 5 minutes) */
  timeout?: number;
  /** Condition pattern like "Write(*.ts)" or "Bash(git *)" */
  if?: string;
  /** Run only once per session (default: false) */
  once?: boolean;
}

/**
 * Raw entry from settings.json - supports both flat and Claude Code shapes
 */
interface RawHookEntry {
  name?: string;
  matcher?: string;
  type?: string;
  command?: string;
  shell?: "bash" | "powershell";
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  timeout?: number;
  if?: string;
  once?: boolean;
  /** Claude Code nested shape */
  hooks?: RawHookEntry[];
}

type HooksByEvent = Record<HookEventName, HookDefinition[]>;

// =============================================================================
// Settings Paths
// =============================================================================

export function hooksSettingsPath(
  scope: "project" | "user",
  projectRoot: string,
): string {
  return scope === "project"
    ? path.join(projectRoot, ".freecode", "settings.json")
    : path.join(os.homedir(), ".freecode", "settings.json");
}

// =============================================================================
// Settings Reading
// =============================================================================

function readHooksFromFile(filePath: string, scope: Scope): HooksByEvent {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || scope === "launch") {
      logger.warn(`[Hooks] Ignoring unreadable settings at ${filePath}: ${error}`);
    }
    return Object.create(null);
  }
  return readHooksDocument(raw, filePath, scope);
}

/**
 * The launch scope is a file path or, like `claude --settings`, the JSON
 * document itself.
 */
function readLaunchHooks(value: string): HooksByEvent {
  const trimmed = value.trim();
  return trimmed.startsWith("{")
    ? readHooksDocument(trimmed, "FREECODE_SETTINGS", "launch")
    : readHooksFromFile(trimmed, "launch");
}

function readHooksDocument(raw: string, label: string, scope: Scope): HooksByEvent {
  const normalized: HooksByEvent = Object.create(null);
  let parsed: { hooks?: Record<string, RawHookEntry[]> };
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn(`[Hooks] Ignoring unparseable settings at ${label}: ${error}`);
    return normalized;
  }

  for (const [event, entries] of Object.entries(parsed?.hooks ?? {})) {
    if (!isValidEventName(event)) {
      logger.warn(
        `[Hooks] Unknown hook event "${event}" - valid events are: ${HOOK_EVENT_NAMES.join(", ")}`,
      );
      continue;
    }
    if (!Array.isArray(entries)) continue;

    const hooks: HookDefinition[] = [];
    entries.forEach((entry, index) => {
      for (const def of normalizeEntry(entry, event, index, scope)) {
        const validated = validateHookDefinition(def, event);
        if (validated) hooks.push(validated);
      }
    });
    normalized[event] = hooks;
  }
  return normalized;
}

/**
 * Check if a string is a valid HookEventName
 */
function isValidEventName(event: string): event is HookEventName {
  return HOOK_EVENT_NAMES.includes(event as HookEventName);
}

/**
 * Normalize a raw entry - handles both flat and Claude Code nested shapes.
 *
 * An unnamed hook is named after its scope and position, so two scopes never
 * collide by accident: only an explicit `name` overrides across scopes.
 */
function normalizeEntry(
  entry: RawHookEntry,
  event: HookEventName,
  index: number,
  scope: Scope,
): Array<HookDefinition & { rawType?: string }> {
  const handlers = Array.isArray(entry.hooks)
    ? entry.hooks.map((h, i) => ({ h, fallback: `${scope}:${event}-${index}-${i}` }))
    : [{ h: entry, fallback: `${scope}:${event}-${index}` }];

  return handlers.map(({ h, fallback }) => ({
    name: h.name ?? fallback,
    matcher: h.matcher ?? entry.matcher,
    type: h.type === "http" ? "http" : "command",
    rawType: h.type,
    command: h.command,
    shell: h.shell,
    url: h.url,
    headers: h.headers,
    allowedEnvVars: h.allowedEnvVars,
    timeout: h.timeout,
    if: h.if ?? entry.if,
    once: h.once ?? entry.once,
  }));
}

/**
 * Validate a hook definition - returns null if invalid (with warning)
 */
function validateHookDefinition(
  def: HookDefinition & { rawType?: string },
  event: HookEventName,
): HookDefinition | null {
  const { rawType, ...hook } = def;
  if (rawType !== undefined && rawType !== "command" && rawType !== "http") {
    logger.warn(
      `[Hooks] Skipping hook "${hook.name}" in ${event}: unsupported type "${rawType}"`,
    );
    return null;
  }

  if (hook.type === "http") {
    if (!hook.url) {
      logger.warn(`[Hooks] Skipping hook "${hook.name}" in ${event}: missing "url" field`);
      return null;
    }
    return hook;
  }

  if (!hook.command) {
    logger.warn(
      `[Hooks] Skipping hook "${hook.name}" in ${event}: missing "command" field`,
    );
    return null;
  }

  return hook;
}

// =============================================================================
// Hook Transformation
// =============================================================================

function toHookCommand(def: HookDefinition): CommandHook | HttpHook {
  // timeout is passed through in seconds; executors/index.ts does timeout * 1000
  if (def.type === "http") {
    return {
      type: "http",
      url: def.url!,
      headers: def.headers,
      allowedEnvVars: def.allowedEnvVars,
      timeout: def.timeout,
      if: def.if,
      once: def.once,
    };
  }
  return {
    type: "command",
    command: def.command!,
    shell: def.shell ?? "bash",
    timeout: def.timeout,
    if: def.if,
    once: def.once,
  };
}

// =============================================================================
// HookSettingsManager
// =============================================================================

/**
 * Manages hooks loaded from settings.json files.
 * Supports project (.freecode/settings.json) and user (~/.freecode/settings.json) scopes.
 * Project hooks take precedence over user hooks for the same name.
 */
export interface HookSettingsOptions {
  /**
   * Hooks for this process only: a settings file path or an inline JSON
   * document. Defaults to FREECODE_SETTINGS. Highest priority; its hooks are
   * added alongside the user's and project's, and replace one only by name.
   */
  launchSettings?: string;
}

export class HookSettingsManager {
  private watchers: fs.FSWatcher[] = [];
  private reloadTimeout: NodeJS.Timeout | null = null;
  private projectRoot: string;
  private launchSettings: string | undefined;

  constructor(projectRoot: string, options: HookSettingsOptions = {}) {
    this.projectRoot = projectRoot;
    this.launchSettings =
      options.launchSettings ?? (process.env.FREECODE_SETTINGS || undefined);
    this.load();
  }

  /** Load and register all hooks from user, project and launch settings */
  load(): void {
    // First, unregister all hooks from settings (for reload)
    unregisterAllHooks("settings");

    const scopes: HooksByEvent[] = [
      readHooksFromFile(hooksSettingsPath("user", this.projectRoot), "user"),
      readHooksFromFile(hooksSettingsPath("project", this.projectRoot), "project"),
      this.launchSettings
        ? readLaunchHooks(this.launchSettings)
        : (Object.create(null) as HooksByEvent),
    ];

    const allEvents = [
      ...new Set(scopes.flatMap((hooks) => Object.keys(hooks))),
    ] as HookEventName[];

    for (const event of allEvents) {
      // A later scope replaces an earlier one's hook of the same name.
      const byName = new Map<string, HookDefinition>();
      for (const hooks of scopes) {
        for (const def of hooks[event] ?? []) byName.set(def.name, def);
      }
      for (const def of byName.values()) {
        registerHook(event, def.name, toHookCommand(def), "settings", {
          matcher: def.matcher,
        });
      }
    }

    logger.debug("[Hooks] Loaded hooks from settings.json");
  }

  /** Reload hooks (called on file change) */
  reload(): void {
    logger.debug("[Hooks] Reloading hooks from settings.json");
    this.load();
  }

  /** Start watching settings files for changes */
  watch(): void {
    if (this.watchers.length > 0) return;

    const dirs = [
      path.dirname(hooksSettingsPath("project", this.projectRoot)),
      path.dirname(hooksSettingsPath("user", this.projectRoot)),
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const watcher = fs.watch(dir, (_event, filename) => {
          if (filename === "settings.json") {
            this.debouncedReload();
          }
        });
        watcher.unref?.();
        this.watchers.push(watcher);
      } catch {
        // Watching is best-effort; manual reload still works
        logger.warn(`[Hooks] Failed to watch ${dir}`);
      }
    }
  }

  private debouncedReload(): void {
    if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
    this.reloadTimeout = setTimeout(() => this.reload(), 300);
  }

  /** Clean up watchers */
  dispose(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.reloadTimeout) clearTimeout(this.reloadTimeout);
  }
}
