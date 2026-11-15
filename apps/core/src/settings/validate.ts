// =============================================================================
// Read both settings scopes and report keys nothing in this codebase reads.
//
// Every reader of settings.json ignores what it does not recognise, which
// meant a typo was invisible: `"permission"` for `"permissions"` disabled
// every rule and looked exactly like the permission system being broken.
// This runs once per process, at bootstrap, and says so on stderr.
//
// Warn only. A settings file with an unknown key is still a usable settings
// file, and refusing to start over a stray key would be a far worse failure
// than the one being fixed.
// =============================================================================

import { readSettingsScopes } from "./load.js";
import { findUnknownSettings } from "./known-keys.js";
import { logger } from "../utils/logger.js";

/**
 * Returns the warnings it emitted, so a caller (or a test) can see them
 * without scraping the log. A file that does not parse is already reported by
 * the loader.
 */
export function warnOnUnknownSettings(projectRoot: string): string[] {
  const emitted: string[] = [];
  for (const doc of readSettingsScopes(projectRoot)) {
    for (const warning of findUnknownSettings(doc.data)) {
      const message = `[Settings] ${warning.message} (${doc.path})`;
      logger.warn(message);
      emitted.push(message);
    }
  }
  return emitted;
}
