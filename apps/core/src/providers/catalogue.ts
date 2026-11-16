// apps/core/src/providers/catalogue.ts
//
// Provider identity, resolved from models.dev rather than hand-maintained.
//
// Three layers, in increasing precedence:
//   1. CATALOGUE_SNAPSHOT — generated at build time by
//      scripts/gen-provider-catalogue.mjs. The offline floor: a first run with
//      no disk cache and no network still knows how to construct a provider.
//   2. models-dev.ts's disk cache — fresher than the snapshot whenever the
//      user has opened the model picker. Read without a TTL check: a stale
//      catalogue entry is strictly better than falling back to a shipped one.
//   3. OVERRIDES — the only freecode-owned data left, and every entry states
//      why it is not simply models.dev's answer.
//
// The network is deliberately not consulted here. `initProviders()` runs on
// the startup path, models-dev.ts already refreshes the cache whenever the
// picker is opened, and blocking session start on models.dev being reachable
// would trade a stale provider list for a dead one.

import { CATALOGUE_SNAPSHOT } from "./catalogue-snapshot.js";
import type { SnapshotEntry } from "./catalogue-types.js";
import { readCachedProviders } from "../models-dev.js";
import { hasSdkFactory } from "./sdk-factories.js";
import { canonicalProviderId } from "./canonical-id.js";
import { OUTPUT_TOKEN_CAP } from "./utils.js";
import type { EffortLevel } from "@thisisayande/freecode-shared";

/**
 * Which `applyEffort()` wire shape a provider's reasoning-effort parameter
 * uses, verified per family against either the AI SDK package's own source
 * (anthropic, openai, gemini, deepseek, groq, xai) or the vendor's own docs
 * (minimax, and the openai-compatible-shaped vendors named in `OVERRIDES`).
 * "openai-compatible" is the one dynamic case: the field lands under
 * `providerOptions[entry.id]`, so it works for any catalogue entry on
 * `@ai-sdk/openai-compatible` that has actually been verified to accept
 * `reasoning_effort` — see the `moonshotai` entry below for how to add one.
 */
export type EffortFamily =
  | "anthropic"
  | "openai"
  | "gemini"
  | "deepseek"
  | "groq"
  | "xai"
  | "openai-compatible";

export interface ProviderCatalogueEntry {
  id: string;
  name: string;
  npm: string;
  /** Custom endpoint. Undefined uses the SDK's own default. */
  baseURL?: string;
  /** Env var names holding this provider's key, in precedence order. */
  envKeys: string[];
  /**
   * Model used when the user has named none. models.dev does not publish a
   * "default", so this is absent for everything but the providers freecode has
   * actually verified one for — `resolveModel` reports the gap rather than
   * guessing a model id that may not exist.
   */
  defaultModel?: string;
  maxOutputTokens: number;
  /**
   * Which `applyEffort()` branch this provider uses, if any. Undefined means
   * effort is not routed — the default, since a provider that does not
   * understand a reasoning-effort parameter rejects the request outright.
   */
  effortFamily?: EffortFamily;
  /**
   * Effort to send when the session has not picked one and `effortFamily` is
   * set. Only worth setting when the provider's own undeclared-effort default
   * is known to be bad — see the `minimax` entry: its docs state
   * `output_config.effort` defaults to `max` (and thinking cannot be disabled
   * at all) when the field is omitted, which is how an un-configured session
   * was burning 10-30k chars of hidden reasoning per tool call.
   */
  defaultEffort?: EffortLevel;
  /**
   * The hand-maintained FALLBACK for which levels this provider's API
   * accepts, ordered low to high. `applyEffort()` prefers models.dev's own
   * per-model `reasoning_options` when that model has one (see effort.ts's
   * `modelsDevEffortValues`) — this field only matters for a model
   * models.dev has no opinion on, or when its data is stale/missing. Either
   * way, anything outside the resolved set snaps to the nearest member,
   * preferring the cheaper neighbor on a tie, the same direction
   * `defaultEffort` already leans. Undefined means "accepts freecode's full
   * five-tier scale as-is" at this fallback layer.
   */
  effortValues?: readonly EffortLevel[];
}

/**
 * freecode-owned data. Everything absent from this table — name, SDK package,
 * baseURL, env var names — comes from models.dev.
 *
 * Two kinds of entry live here, and they are not the same thing:
 *   - Request-shaping defaults (`defaultModel`, `maxOutputTokens`,
 *     `effortFamily`) which models.dev does not publish at all.
 *   - Deliberate divergences from models.dev's own npm/baseURL, each carrying
 *     the reason it is not simply wrong to disagree.
 */
const OVERRIDES: Record<string, Partial<ProviderCatalogueEntry>> = {
  anthropic: {
    defaultModel: "claude-sonnet-4-5",
    effortFamily: "anthropic",
  },
  openai: {
    defaultModel: "gpt-4o",
    effortFamily: "openai",
  },
  gemini: {
    // Verified against the live API 2026-08-29: `gemini-2.0-flash` returns "no
    // longer available" outright and `gemini-2.5-flash` "no longer available to
    // new users", both pointing here. A retired default is not a soft failure —
    // it breaks the provider for anyone who does not name a model.
    defaultModel: "gemini-3.6-flash",
    effortFamily: "gemini",
    // thinkingLevel tops out at "high" — the generic clamp in effort.ts snaps
    // xhigh/max down to it, replacing what used to be a one-off inline check.
    effortValues: ["low", "medium", "high"],
  },
  minimax: {
    defaultModel: "MiniMax-M2",
    // The old 4096 default truncated large tool calls (e.g. a `write` with a
    // long body) mid-JSON, which the AI SDK then surfaced as an unparseable
    // tool call. The endpoint's own ceilings are far higher — 524288 for
    // MiniMax-M3, 196608 for MiniMax-M2 — so this only needs to be large
    // enough for a full file write in one call. It was 65536, but MiniMax
    // charges max_tokens against the same context window, so that reserved a
    // third of M2's 196608 and forced auto-compaction to fire at 60%
    // occupancy. OUTPUT_TOKEN_CAP keeps the write headroom while giving the
    // rest of the window back to the conversation.
    maxOutputTokens: OUTPUT_TOKEN_CAP,
    // Verified against MiniMax's own docs (platform.minimax.io/docs/api-reference/
    // text-anthropic-api, 2026-11-17): the Anthropic-compatible endpoint's
    // `output_config.effort` field takes the exact same low|medium|high|xhigh|max
    // scale Anthropic's own adaptive-effort models use, so the "anthropic"
    // applyEffort() branch is the right shape here too. MiniMax-M3.1-Flash
    // defaults that field to "max" when the request omits it entirely (and
    // rejects "disabled" outright — thinking can't be turned off), which is
    // why a session that never called /effort was sending every grep/read/bash
    // turn through maximum reasoning depth: 10-30k+ chars of hidden thinking
    // for a single tool call. `defaultEffort` only fires when the session has
    // not chosen one itself.
    effortFamily: "anthropic",
    defaultEffort: "medium",
  },
  deepseek: {
    // models.dev routes deepseek through @ai-sdk/openai-compatible. freecode
    // carries the dedicated @ai-sdk/deepseek package, which additionally maps
    // `prompt_cache_hit_tokens` into the usage breakdown that pricing.ts bills
    // from — the generic openai-compatible adapter reports it as a plain input
    // token, so switching would silently overbill cached reads.
    npm: "@ai-sdk/deepseek",
    baseURL: undefined,
    defaultModel: "deepseek-chat",
    // Verified in @ai-sdk/deepseek's own source (dist/index.mjs): it declares
    // `reasoningEffort: z.enum(["low","medium","high","xhigh","max"])` and
    // remaps "medium"->"high"/"xhigh"->"max" itself before the request goes
    // out, logging a warning either way. No `defaultEffort`: unlike minimax
    // and moonshotai, DeepSeek's own undeclared-effort default has not been
    // checked, so an unset session leaves the field unsent rather than guess.
    effortFamily: "deepseek",
  },
  groq: {
    // Verified in @ai-sdk/groq's own source: `reasoningEffort` accepts
    // "none"|"default"|"low"|"medium"|"high" — no xhigh/max — mapped onto the
    // wire as `reasoning_effort`. No `defaultEffort`: Groq's own
    // undeclared-effort default has not been checked.
    effortFamily: "groq",
    effortValues: ["low", "medium", "high"],
  },
  xai: {
    // Verified in @ai-sdk/xai's own source: `reasoningEffort` accepts
    // "none"|"low"|"medium"|"high"|"xhigh" — no "max" — mapped onto the wire
    // as `reasoning_effort`. No `defaultEffort`: xAI's own undeclared-effort
    // default has not been checked.
    effortFamily: "xai",
    effortValues: ["low", "medium", "high", "xhigh"],
  },
  moonshotai: {
    // Moonshot's own docs (platform.kimi.ai/docs/guide/use-reasoning-effort,
    // 2026-11-17): Kimi K3 takes a top-level `reasoning_effort` on Chat
    // Completions — exactly what @ai-sdk/openai-compatible's generic
    // `reasoningEffort` field already sends — accepting only low|high|max,
    // defaulting to **max** when the request omits it (same bug shape as
    // minimax/MiniMax-M3.1-Flash: K3 always reasons, there is no "off").
    // `providerOptionsName` for this package is the catalogue id ("moonshotai"),
    // which is what makes this entry's effort land at all.
    effortFamily: "openai-compatible",
    effortValues: ["low", "high", "max"],
    defaultEffort: "medium",
  },
  "zai-coding-plan": {
    // Live-verified 2026-11-17 against the real API (not just docs): the
    // same "grep this repo" prompt at effort "low" vs "max" produced 0 vs
    // ~95 thinkingChars, no error either side. This is a DIFFERENT baseURL
    // than the plain `zai` entry below (openai-compatible .../coding/paas/v4,
    // not the anthropic-shaped endpoint `zai` is forced onto), so it is not
    // affected by that entry's unresolved ambiguity.
    effortFamily: "openai-compatible",
    effortValues: ["low", "high", "max"],
  },
  "zhipuai-coding-plan": {
    // Same vendor and npm package as `zai-coding-plan`, baseURL differing
    // only by domain (open.bigmodel.cn vs api.z.ai) — also live-verified
    // 2026-11-17, effort "low" ran clean with no error.
    effortFamily: "openai-compatible",
    effortValues: ["low", "high", "max"],
  },
  zhipuai: {
    // Same API family as `zhipuai-coding-plan`, minus the /coding path — not
    // independently live-tested, but no reason to expect this one param to
    // behave differently on the same vendor's base endpoint.
    effortFamily: "openai-compatible",
    effortValues: ["low", "high", "max"],
  },
  zai: {
    // models.dev lists zai as openai-compatible against .../paas/v4. z.ai also
    // exposes an Anthropic Messages-compatible endpoint, and freecode uses it
    // deliberately: that path accepts the cache breakpoints `applyMessageCaching`
    // sets, which the openai-compatible path has no way to express.
    npm: "@ai-sdk/anthropic",
    baseURL: "https://api.z.ai/api/anthropic",
    defaultModel: "glm-5.2",
    // Checked 2026-11-17, deliberately left without an effortFamily: z.ai's
    // own docs and third-party references disagree on the shape — some say a
    // top-level `reasoning_effort` field (which @ai-sdk/anthropic has no way
    // to send; it only knows `output_config.effort`/`thinking.budget_tokens`),
    // others say `output_config.effort` works. Unlike minimax, where the
    // vendor's own docs state the exact same shape @ai-sdk/anthropic already
    // sends, this one is not verified — sending the wrong shape risks a
    // rejected request, which is worse than the current no-op. Do not set
    // effortFamily here without a live confirmed call against the real API.
  },
};

/**
 * Providers freecode lists even with no credential on file, so a new install
 * has something to pick from. Everything else in the catalogue still resolves
 * and runs — it just does not advertise itself before it can be used.
 *
 * This is a discovery list, not a support list: it says which names are worth
 * showing to someone who has configured nothing, and nothing more.
 */
export const FEATURED_PROVIDER_IDS = [
  "anthropic",
  "openai",
  "gemini",
  "minimax",
  "deepseek",
  "zai",
];

const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

function toEntry(snapshot: SnapshotEntry): ProviderCatalogueEntry {
  const id = canonicalProviderId(snapshot.id);
  const override = OVERRIDES[id] ?? {};
  return {
    id,
    name: snapshot.name,
    npm: snapshot.npm,
    baseURL: snapshot.baseURL,
    envKeys: snapshot.envKeys,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    ...override,
  };
}

/**
 * The resolved catalogue, newest-source-wins, filtered to entries freecode can
 * actually construct.
 *
 * Entries whose SDK package has no bundled factory are dropped rather than
 * registered-and-broken: a provider that appears in the picker and throws
 * "No bundled SDK" on first use is worse than one that never appeared.
 */
export function resolveCatalogue(): ProviderCatalogueEntry[] {
  if (!memo) memo = computeCatalogue();
  return memo;
}

// Memoized for the life of the process. Resolution walks 212 snapshot entries
// plus the disk cache, and `hasApiKey` reaches it once per provider — with
// `providers.list` asking about every provider, resolving on each call turned
// opening the model picker into a 3.4s stall.
let memo: ProviderCatalogueEntry[] | undefined;
let envKeyIndex: Map<string, string[]> | undefined;

/** Drops the memo so the next read picks up a refreshed models.dev cache. */
export function invalidateCatalogue(): void {
  memo = undefined;
  envKeyIndex = undefined;
}

function computeCatalogue(): ProviderCatalogueEntry[] {
  // Keyed by canonical id, not raw: the snapshot carries models.dev's
  // "google" while the disk cache is written post-remap as "gemini", and
  // keying on the raw id would resolve both into two entries for one provider.
  const byId = new Map<string, SnapshotEntry>();
  for (const entry of CATALOGUE_SNAPSHOT) byId.set(canonicalProviderId(entry.id), entry);

  for (const cached of readCachedProviders() ?? []) {
    // A cache written before the catalogue carried SDK metadata has no npm;
    // the snapshot's entry is the better answer until it refreshes.
    if (!cached.npm) continue;
    byId.set(canonicalProviderId(cached.id), {
      id: cached.id,
      name: cached.name,
      npm: cached.npm,
      baseURL: cached.api,
      envKeys: cached.env ?? [],
    });
  }

  const resolved: ProviderCatalogueEntry[] = [];
  for (const snapshot of byId.values()) {
    const entry = toEntry(snapshot);
    if (!hasSdkFactory(entry.npm)) continue;
    resolved.push(entry);
  }
  return resolved;
}

/**
 * Env var names for a provider id, for callers outside the registry.
 *
 * Indexed rather than scanned: `hasApiKey` calls this per provider, and
 * `providers.list` calls `hasApiKey` for all ~198 of them.
 */
export function envKeysFor(id: string): string[] {
  if (!envKeyIndex) {
    envKeyIndex = new Map(resolveCatalogue().map((e) => [e.id, e.envKeys]));
  }
  return envKeyIndex.get(id) ?? [];
}

/**
 * Catalogue `baseURL`, or `$<ID>_BASE_URL` when set.
 *
 * The recording proxy in `bench/agent-bench` points every agent at one meter
 * (spec §6.4). Claude Code already honours `ANTHROPIC_BASE_URL`; freecode
 * previously ignored it because the SDK is constructed with the catalogue
 * URL. `MINIMAX_BASE_URL` (and the same pattern for any other id) is the
 * equivalent hook — a bench-only override, not a documented user setting.
 */
export function baseURLFor(entry: {
  id: string;
  baseURL?: string;
}): string | undefined {
  const envName = `${entry.id.replace(/-/g, "_").toUpperCase()}_BASE_URL`;
  return process.env[envName] || entry.baseURL;
}
