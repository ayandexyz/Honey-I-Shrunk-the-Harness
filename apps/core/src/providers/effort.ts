import type { EffortLevel } from "./types.js";
import type { EffortFamily, ProviderCatalogueEntry } from "./catalogue.js";
import { findModelReasoningOptions } from "../models-dev.js";

const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_LEVELS = new Set<string>(EFFORT_ORDER);

/**
 * The opencode philosophy: models.dev's own per-model `reasoning_options` is
 * the primary source of which effort values a model accepts — not a
 * hand-maintained guess — because it is sourced from the vendor and updated
 * as models change (the exact gap that bit the `zai`/glm-5.2 entry: models.dev
 * says `["none","high","xhigh"]`, which matches neither of two reasonable
 * guesses). Only the "effort" option type maps onto freecode's EffortLevel
 * scale; "toggle"/"budget_tokens" entries, and any model models.dev has no
 * opinion on, fall through to `undefined` so the caller uses the catalogue's
 * own hand-verified `effortValues` instead. A value models.dev lists that
 * isn't one of freecode's five tiers (e.g. "none") is dropped rather than
 * kept — `clampToSupported` only knows how to reason about this scale.
 */
function modelsDevEffortValues(
  providerId: string,
  modelId: string,
): readonly EffortLevel[] | undefined {
  const options = findModelReasoningOptions(providerId, modelId);
  const effortOption = options?.find((o) => o.type === "effort");
  if (effortOption?.type !== "effort") return undefined;
  const values = effortOption.values.filter((v): v is EffortLevel =>
    EFFORT_LEVELS.has(v),
  );
  return values.length > 0 ? values : undefined;
}

/**
 * Snaps `effort` to the nearest level `values` actually contains, walking
 * outward from its position in `EFFORT_ORDER`. When a value sits exactly
 * between two supported levels (e.g. "medium" against ["low","high","max"]),
 * the lower neighbor wins — the whole point of this module is to stop a
 * provider from defaulting to more reasoning than asked for, so an ambiguous
 * clamp should never round up. `values` undefined means the provider accepts
 * freecode's full five-tier scale as-is.
 */
export function clampToSupported(
  effort: EffortLevel,
  values: readonly EffortLevel[] | undefined,
): EffortLevel {
  if (!values || values.includes(effort)) return effort;
  const idx = EFFORT_ORDER.indexOf(effort);
  for (let d = 1; d < EFFORT_ORDER.length; d++) {
    const lower = EFFORT_ORDER[idx - d];
    if (lower && values.includes(lower)) return lower;
    const higher = EFFORT_ORDER[idx + d];
    if (higher && values.includes(higher)) return higher;
  }
  return effort;
}

/**
 * Routes a resolved effort level into the right `providerOptions` slot for
 * `entry.effortFamily`, each verified against either the AI SDK package's
 * own source (anthropic, openai, gemini, deepseek, groq, xai) or the
 * vendor's documented API shape (minimax; any `openai-compatible` entry
 * named in `catalogue.ts`'s `OVERRIDES`). "openai-compatible" is the one
 * family whose providerOptions key is dynamic — `@ai-sdk/openai-compatible`
 * reads it back under whatever `name` freecode constructed the client with,
 * which `generic-provider.ts` sets to the catalogue id.
 *
 * `modelId`, when given, lets models.dev's own per-model `reasoning_options`
 * override `entry.effortValues` for this one call — see
 * `modelsDevEffortValues` above.
 */
export function applyEffort(
  generateOptions: { providerOptions?: Record<string, unknown> },
  entry: Pick<ProviderCatalogueEntry, "id" | "effortFamily" | "effortValues">,
  effort: EffortLevel | undefined,
  modelId?: string,
): void {
  if (!effort || !entry.effortFamily) return;
  const liveValues = modelId
    ? modelsDevEffortValues(entry.id, modelId)
    : undefined;
  const resolved = clampToSupported(effort, liveValues ?? entry.effortValues);
  const providerOptions = { ...generateOptions.providerOptions };
  const family: EffortFamily = entry.effortFamily;
  switch (family) {
    case "anthropic":
      providerOptions.anthropic = { ...(providerOptions.anthropic as object), effort: resolved };
      break;
    case "openai":
      providerOptions.openai = {
        ...(providerOptions.openai as object),
        reasoningEffort: resolved,
      };
      break;
    case "gemini":
      providerOptions.google = {
        ...(providerOptions.google as object),
        thinkingConfig: { thinkingLevel: resolved },
      };
      break;
    case "deepseek":
      providerOptions.deepseek = {
        ...(providerOptions.deepseek as object),
        reasoningEffort: resolved,
      };
      break;
    case "groq":
      providerOptions.groq = {
        ...(providerOptions.groq as object),
        reasoningEffort: resolved,
      };
      break;
    case "xai":
      providerOptions.xai = {
        ...(providerOptions.xai as object),
        reasoningEffort: resolved,
      };
      break;
    case "openai-compatible":
      providerOptions[entry.id] = {
        ...(providerOptions[entry.id] as object),
        reasoningEffort: resolved,
      };
      break;
  }
  generateOptions.providerOptions = providerOptions;
}
