import type { EffortLevel } from "./types.js";
import type { EffortFamily, ProviderCatalogueEntry } from "./catalogue.js";

const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

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
 */
export function applyEffort(
  generateOptions: { providerOptions?: Record<string, unknown> },
  entry: Pick<ProviderCatalogueEntry, "id" | "effortFamily" | "effortValues">,
  effort: EffortLevel | undefined,
): void {
  if (!effort || !entry.effortFamily) return;
  const resolved = clampToSupported(effort, entry.effortValues);
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
