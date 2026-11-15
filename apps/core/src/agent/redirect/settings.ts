// =============================================================================
// Redirect settings — project → user → default, through `settings/load.ts`.
//
// **Off by default (D8).** Shipping this on and then measuring would mean every
// user pays for an unvalidated model call on a signal we already know produced
// false positives before Phase 0. The flip criterion is written down in §9 of
// the spec so it is a fact, not a judgement call.
// =============================================================================

import { REDIRECT_MAX_PER_RUN } from "./policy.js";
import {
  isBool,
  isNumberAtLeast,
  pickSetting,
  settingsSections,
} from "../../settings/load.js";

const ENV_DISABLE = "FREECODE_DISABLE_REDIRECT";

export interface RedirectSettings {
  enabled: boolean;
  maxPerRun: number;
}

function isEnvTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function loadRedirectSettings(projectRoot: string): RedirectSettings {
  const sections = settingsSections(projectRoot, "redirect");
  const enabled = pickSetting(sections, "enabled", isBool);
  const maxPerRun = pickSetting(sections, "maxPerRun", isNumberAtLeast(0));
  return {
    enabled: (enabled ?? false) && !isEnvTruthy(process.env[ENV_DISABLE]),
    maxPerRun: maxPerRun !== undefined ? Math.floor(maxPerRun) : REDIRECT_MAX_PER_RUN,
  };
}

/**
 * The cap actually in force this run.
 *
 * An unattended run's budget wins over the user's interactive preference,
 * because a run's recovery attempts are part of its spend, not a separate
 * allowance a settings file may raise (`2026-08-26-trajectory-redirection.md`
 * Phase 3, `2026-08-10-autonomous-runs-design.md` §4.3). `enabled` is
 * deliberately NOT overridden: a budget says how much, never whether — a user
 * who switched redirection off must not have it switched back on by starting a
 * run.
 *
 * `budgetMaxRedirects` is undefined for an ordinary interactive run, which is
 * every run until autonomous execution ships.
 */
export function effectiveRedirectCap(
  settings: RedirectSettings,
  budgetMaxRedirects?: number,
): number {
  if (budgetMaxRedirects === undefined) return settings.maxPerRun;
  return Math.max(0, Math.min(settings.maxPerRun, budgetMaxRedirects));
}
