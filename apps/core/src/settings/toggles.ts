// =============================================================================
// Settings a frontend may flip — the `/settings` panel's model.
//
// Each entry names a key in settings.json and reads its EFFECTIVE value
// through the module that owns it, so the scope order and env rules stay in
// one place per setting instead of being restated here.
//
// Writes go to the USER file (~/.freecode/settings.json) only. A value the
// user file cannot decide — set by an env var or by the project's
// `.freecode/settings.json` — is reported `locked`, with the reason, rather
// than written to a scope that would be ignored.
// =============================================================================

import type { SettingView } from "@thisisayande/freecode-shared";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadMemorySettings } from "../memory/extract-policy.js";
import { loadConsolidationSettings } from "../memory/consolidate-policy.js";
import { loadCheckpointSettings } from "../checkpoint/settings.js";
import { taskNotificationsEnabled } from "../agent/task-notify.js";
import { resolveCacheWarmingMode } from "../providers/cache-warmer.js";
import { loadRedirectSettings } from "../agent/redirect/settings.js";
import { loadSignalSettings } from "../agent/signals/settings.js";

interface ToggleDef {
  key: string;
  /** Path in settings.json. */
  path: string[];
  label: string;
  description: string;
  /** Allowed values; booleans are shown as on/off. */
  values: readonly string[];
  /** The env vars that beat the files. */
  env: readonly string[];
  read(projectRoot: string): string;
}

const onOff = (v: boolean): string => (v ? "on" : "off");
const BOOL = ["on", "off"] as const;

const TOGGLES: readonly ToggleDef[] = [
  {
    key: "memory.autoRecall",
    path: ["memory", "autoRecall"],
    label: "Memory recall",
    description: "Inject relevant memories into every request. The memory tool stays either way.",
    values: BOOL,
    env: ["FREECODE_DISABLE_MEMORY_RECALL"],
    read: (root) => onOff(loadMemorySettings(root).autoRecall),
  },
  {
    key: "memory.autoExtract",
    path: ["memory", "autoExtract"],
    label: "Memory extraction",
    description: "Mine finished turns for memories worth keeping.",
    values: BOOL,
    env: ["FREECODE_DISABLE_MEMORY_EXTRACTION"],
    read: (root) => onOff(loadMemorySettings(root).autoExtract),
  },
  {
    key: "memory.retrievalJudge",
    path: ["memory", "retrievalJudge"],
    label: "Memory judge",
    description: "An extra model call that vets recalled memories. Measured cost- and quality-neutral.",
    values: BOOL,
    env: ["FREECODE_DISABLE_MEMORY_JUDGE"],
    read: (root) => onOff(loadMemorySettings(root).retrievalJudge),
  },
  {
    key: "memory.autoConsolidate",
    path: ["memory", "autoConsolidate"],
    label: "Memory consolidation",
    description: "Merge overlapping memories, at most once a day per project.",
    values: BOOL,
    env: ["FREECODE_DISABLE_MEMORY_CONSOLIDATION"],
    read: (root) => onOff(loadConsolidationSettings(root).autoConsolidate),
  },
  {
    key: "checkpoints.enabled",
    path: ["checkpoints", "enabled"],
    label: "Checkpoints",
    description: "Snapshot the working tree each turn so /rewind can undo file changes. Git repos only.",
    values: BOOL,
    env: ["FREECODE_CHECKPOINTS"],
    read: (root) => onOff(loadCheckpointSettings(root).enabled),
  },
  {
    key: "tasks.notify",
    path: ["tasks", "notify"],
    label: "Background notifications",
    description: "Tell the agent when a background agent or shell finishes. Off makes background work run in the foreground.",
    values: BOOL,
    env: ["FREECODE_TASK_NOTIFY"],
    read: (root) => onOff(taskNotificationsEnabled(root)),
  },
  {
    key: "cache.warming",
    path: ["cache", "warming"],
    label: "Cache warming",
    description: "Refresh the Anthropic prompt cache before it expires, when the saving is worth it.",
    values: ["off", "streaming", "idle"],
    env: ["FREECODE_CACHE_WARMING"],
    read: (root) => resolveCacheWarmingMode(root),
  },
  {
    key: "redirect.enabled",
    path: ["redirect", "enabled"],
    label: "Trajectory redirect",
    description: "Experimental: advise the agent when the loop looks stuck.",
    values: BOOL,
    env: ["FREECODE_DISABLE_REDIRECT"],
    read: (root) => onOff(loadRedirectSettings(root).enabled),
  },
  {
    key: "signals.autoPoke.enabled",
    path: ["signals", "autoPoke", "enabled"],
    label: "Auto-poke",
    description: "Experimental: send the agent back when it stops with open todos.",
    values: BOOL,
    env: ["FREECODE_AUTO_POKE"],
    read: (root) => onOff(loadSignalSettings(root).autoPoke.enabled),
  },
  {
    key: "signals.confidenceGate.enabled",
    path: ["signals", "confidenceGate", "enabled"],
    label: "Confidence gate",
    description: "Experimental: make the agent verify a todo whose confidence jumps.",
    values: BOOL,
    env: ["FREECODE_CONFIDENCE_GATE"],
    read: (root) => onOff(loadSignalSettings(root).confidenceGate.enabled),
  },
  {
    key: "signals.hillClimbGate.enabled",
    path: ["signals", "hillClimbGate", "enabled"],
    label: "Hill-climb gate",
    description: "Experimental: ask for a reframe when a todo is hard to make progress on.",
    values: BOOL,
    env: ["FREECODE_HILLCLIMB_GATE"],
    read: (root) => onOff(loadSignalSettings(root).hillClimbGate.enabled),
  },
];

const userFile = (): string => path.join(os.homedir(), ".freecode", "settings.json");
const projectFile = (root: string): string => path.join(root, ".freecode", "settings.json");

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function has(obj: Record<string, unknown> | undefined, keys: string[]): boolean {
  let at: unknown = obj;
  for (const k of keys) {
    if (!at || typeof at !== "object" || !(k in at)) return false;
    at = (at as Record<string, unknown>)[k];
  }
  return true;
}

function lockReason(def: ToggleDef, projectRoot: string, env: NodeJS.ProcessEnv): string | undefined {
  const envVar = def.env.find((name) => (env[name] ?? "") !== "");
  if (envVar) return `Set by ${envVar}=${env[envVar]}`;
  // The project file is read first, so a key there beats the user file.
  if (path.resolve(projectFile(projectRoot)) !== path.resolve(userFile())
    && has(readJson(projectFile(projectRoot)), def.path)) {
    return "Set in this project's .freecode/settings.json";
  }
  return undefined;
}

export function listSettings(projectRoot: string, env: NodeJS.ProcessEnv = process.env): SettingView[] {
  return TOGGLES.map((def) => ({
    key: def.key,
    label: def.label,
    description: def.description,
    values: [...def.values],
    value: def.read(projectRoot),
    locked: lockReason(def, projectRoot, env),
  }));
}

/**
 * Write one setting to the user file. Refuses a value outside the list, and
 * refuses to touch a user file that exists but is not a JSON object — the
 * user's hand edits are worth more than one toggle.
 */
export function setSetting(key: string, value: string): void {
  const def = TOGGLES.find((t) => t.key === key);
  if (!def) throw new Error(`Unknown setting: ${key}`);
  if (!def.values.includes(value)) {
    throw new Error(`${key} must be one of ${def.values.join(", ")}`);
  }

  const file = userFile();
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = readJson(file);
    if (!parsed) throw new Error(`${file} is not valid JSON; fix it by hand first`);
    settings = parsed;
  }

  let at = settings;
  for (const k of def.path.slice(0, -1)) {
    const next = at[k];
    at = (at[k] = next && typeof next === "object" && !Array.isArray(next) ? next : {}) as Record<string, unknown>;
  }
  const leaf = def.path[def.path.length - 1]!;
  at[leaf] = def.values === BOOL ? value === "on" : value;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, file);
}
