// =============================================================================
// The one settings.json loader.
//
// Every subsystem used to open and parse `settings.json` itself — eleven
// copies of "read project, then user, swallow errors" — and the merge rule had
// to be reconstructed from each. Now they all come through here, and there is
// one rule, the one Claude Code and pi use:
//
//   **Project beats user, key by key.** A value the project file sets (and
//   that is valid for its key) wins; anything it leaves out, or sets to
//   something invalid, falls through to the user file, then the default.
//   **Lists accumulate** across scopes — `permissions.allow|ask|deny` and
//   `hooks.<event>` — and a hook only replaces another of the same `name`.
//
// Environment variables beat both files, and stay each reader's business.
// A few keys are trusted only from the user file (`extensions.trustedProjects`:
// a repository must not be able to vouch for itself); those readers ask for
// `readSettingsScope("user")` directly.
//
// A file is parsed once per version (mtime + size + inode), so readers can keep
// calling per run — which is how a `/settings` flip or an `eval ab` env change
// applies on the next turn — without re-parsing it each time. A file that does
// not parse is treated as empty for its scope and warned about once.
// =============================================================================

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { logger } from "../utils/logger.js";

export type SettingsScope = "project" | "user";

export type SettingsObject = Record<string, unknown>;

export interface SettingsScopeDoc {
  scope: SettingsScope;
  path: string;
  data: SettingsObject;
}

export function settingsFile(scope: SettingsScope, projectRoot: string): string {
  return scope === "project"
    ? path.join(projectRoot, ".freecode", "settings.json")
    : path.join(os.homedir(), ".freecode", "settings.json");
}

interface CacheEntry {
  version: string;
  data: SettingsObject | undefined;
}

const cache = new Map<string, CacheEntry>();

/** Test seam; production never needs it, the version key invalidates. */
export function resetSettingsCache(): void {
  cache.clear();
}

const isObject = (v: unknown): v is SettingsObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The parsed document at `filePath`, or undefined when it is missing or
 * unusable. Missing is silent; anything else warns once per file version.
 */
export function readSettingsFile(filePath: string): SettingsObject | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    cache.delete(filePath);
    return undefined;
  }
  const version = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  const hit = cache.get(filePath);
  if (hit?.version === version) return hit.data;

  let data: SettingsObject | undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (isObject(parsed)) data = parsed;
    else logger.warn(`[Settings] ${filePath} is not a JSON object — ignoring it.`);
  } catch (error) {
    logger.warn(`[Settings] Ignoring unreadable settings at ${filePath}: ${error}`);
  }
  cache.set(filePath, { version, data });
  return data;
}

export function readSettingsScope(
  scope: SettingsScope,
  projectRoot: string,
): SettingsScopeDoc | undefined {
  const file = settingsFile(scope, projectRoot);
  const data = readSettingsFile(file);
  return data ? { scope, path: file, data } : undefined;
}

/**
 * Both scopes, highest priority first (project, then user). When the project
 * IS the home directory the two paths are one file, read once, as the user's.
 */
export function readSettingsScopes(projectRoot: string): SettingsScopeDoc[] {
  const user = readSettingsScope("user", projectRoot);
  const sameFile =
    path.resolve(settingsFile("project", projectRoot)) ===
    path.resolve(settingsFile("user", projectRoot));
  const project = sameFile ? undefined : readSettingsScope("project", projectRoot);
  return [project, user].filter((d): d is SettingsScopeDoc => d !== undefined);
}

/**
 * Each scope's object at `keyPath` (e.g. `["signals", "autoPoke"]`), highest
 * priority first. Scopes that do not set it, or set it to a non-object, are
 * left out.
 */
export function settingsSections(projectRoot: string, ...keyPath: string[]): SettingsObject[] {
  const out: SettingsObject[] = [];
  for (const doc of readSettingsScopes(projectRoot)) {
    let at: unknown = doc.data;
    for (const k of keyPath) at = isObject(at) ? at[k] : undefined;
    if (isObject(at)) out.push(at);
  }
  return out;
}

/**
 * The first scope's value for `field` that `accept` takes — "project beats
 * user, key by key", with an invalid value falling through to the next scope.
 */
export function pickSetting<T>(
  sections: readonly SettingsObject[],
  field: string,
  accept: (v: unknown) => v is T,
): T | undefined {
  for (const s of sections) {
    const v = s[field];
    if (accept(v)) return v;
  }
  return undefined;
}

export const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** A finite number at least `min`. */
export const isNumberAtLeast =
  (min: number) =>
  (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v >= min;
