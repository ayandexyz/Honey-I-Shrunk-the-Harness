// apps/core/src/models-dev.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OUTPUT_TOKEN_CAP } from "./providers/utils.js";
import { canonicalProviderId } from "./providers/canonical-id.js";

/**
 * Where the catalogue comes from. `FREECODE_MODELS_URL` redirects it — for an
 * air-gapped install pointing at an internal mirror, and for tests that must
 * not reach the network. (opencode carries the same seam as
 * `OPENCODE_MODELS_URL`, and defaults to a mirror it controls rather than
 * models.dev directly.)
 */
function modelsUrl(): string {
  return process.env.FREECODE_MODELS_URL ?? "https://models.dev/api.json";
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Give up on a single attempt after this long.
 *
 * `FREECODE_MODELS_TIMEOUT_MS` overrides it.
 *
 * Without it a hung connection hangs forever: `https.get` has no default
 * timeout, and this feed is now on the path of the model picker, provider
 * identity, and pricing. A stalled socket would leave all three waiting on a
 * response that never comes, with no error to fall back from.
 */
function fetchTimeoutMs(): number {
  const raw = Number(process.env.FREECODE_MODELS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

/** Attempts per fetch. Transient 5xx and dropped sockets are common enough
 *  that one failure should not push every caller onto the stale-cache path. */
const FETCH_ATTEMPTS = 3;

const CACHE_DIR = path.join(os.homedir(), ".freecode", "cache");

/**
 * Where the models.dev response is cached.
 *
 * `FREECODE_MODELS_CACHE_FILE` redirects it, which is what makes anything
 * reading this cache testable — `providers/pricing.ts` now derives rates from
 * it, and a test that asserts a price must not depend on whether the developer
 * running it happens to have opened the model picker. (opencode carries the
 * same seam as `OPENCODE_MODELS_PATH`.) Resolved per call, not once at import,
 * so a test can set it after this module is loaded.
 */
function cacheFile(): string {
  return (
    process.env.FREECODE_MODELS_CACHE_FILE ??
    path.join(CACHE_DIR, "models-dev.json")
  );
}

/** Token limits for a model, as reported by models.dev. */
export interface ModelLimit {
  /** Context-window size (max input tokens). */
  context: number;
  /** Max output tokens per response. */
  output: number;
}

/** USD per million tokens, as models.dev publishes them. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * A model's reasoning-effort capability, as models.dev publishes it per
 * model (not per provider) — the same field opencode's `supports()` reads
 * to drive its own effort dispatch. "effort" is the only type freecode's
 * `EffortLevel` scale currently maps onto; "toggle"/"budget_tokens" are
 * carried through for completeness but nothing yet consumes them.
 */
export type ReasoningOption =
  | { readonly type: "effort"; readonly values: readonly string[] }
  | { readonly type: "toggle" }
  | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number };

export interface ProviderModel {
  id: string;
  name: string;
  description?: string;
  /** Present when models.dev reports limits for this model. */
  limit?: ModelLimit;
  /** Present when models.dev publishes a rate card for this model. */
  cost?: ModelCost;
  /** Input modalities, e.g. ["text", "image", "pdf"]. Absent if unreported. */
  inputModalities?: string[];
  /** Whether this specific model supports reasoning at all. */
  reasoning?: boolean;
  /**
   * Whether this model accepts a `temperature` parameter. Absent means
   * models.dev has no opinion — treated as "accepts it", the existing
   * default — so this can only ever suppress a param for a model that
   * explicitly declares it unsupported, never wrongly add one.
   */
  temperature?: boolean;
  /**
   * Whether this model can be sent tool definitions at all. Same
   * fail-open-on-absence rule as `temperature`: only ever suppresses tools
   * for a model models.dev explicitly marks as `tool_call: false`.
   */
  toolCall?: boolean;
  /**
   * How to drive that reasoning, with the exact accepted values when the
   * type is "effort" — e.g. a specific GLM version may only take
   * ["none","high","xhigh"], not the full low..max scale. Absent or empty
   * means models.dev has nothing more specific than `reasoning` itself; a
   * caller resolving an effort value falls back to its own hand-verified
   * default for that case rather than treating absence as "no reasoning".
   */
  reasoningOptions?: readonly ReasoningOption[];
}

export interface Provider {
  id: string;
  name: string;
  description?: string;
  models: ProviderModel[];
  /**
   * SDK package name, custom endpoint, and env var names, as models.dev
   * publishes them. Carried through so `providers/catalogue.ts` can construct
   * a provider from this data instead of a hand-maintained table; absent on a
   * cache written before that existed.
   */
  npm?: string;
  api?: string;
  env?: string[];
}

let cache: { data: Provider[]; timestamp: number; etag?: string } | null =
  null;

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/** The raw disk cache regardless of TTL — the only way to read a stale
 *  entry's `etag` for a conditional refetch. */
function loadRawFromDisk(): {
  data: Provider[];
  timestamp: number;
  etag?: string;
} | null {
  try {
    const file = cacheFile();
    if (!fs.existsSync(file)) return null;
    const cached = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(cached?.data) ? cached : null;
  } catch {
    return null;
  }
}

function loadFromDisk(): Provider[] | null {
  const cached = loadRawFromDisk();
  if (!cached || Date.now() - cached.timestamp > CACHE_TTL_MS) return null;
  return cached.data;
}

function saveToDisk(providers: Provider[], etag?: string): void {
  ensureCacheDir();
  fs.writeFileSync(
    cacheFile(),
    JSON.stringify(
      { data: providers, timestamp: Date.now(), ...(etag ? { etag } : {}) },
      null,
      2,
    ),
  );
}

/**
 * The disk cache regardless of its TTL, for callers that need an answer
 * without a network round trip.
 *
 * `loadFromDisk` returns null once the cache is 5 minutes old, which is right
 * for the model picker — a stale model list is a wrong model list. It is wrong
 * for provider *identity*, which changes on the order of months: a five-minute
 * expiry there would mean falling back to the shipped snapshot on almost every
 * run, discarding a cache that is still correct.
 */
export function readCachedProviders(): Provider[] | null {
  if (cache) return cache.data;
  try {
    const file = cacheFile();
    if (!fs.existsSync(file)) return null;
    const cached = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(cached?.data) ? (cached.data as Provider[]) : null;
  } catch {
    return null;
  }
}

/** When the disk cache was written, or null when there is none. */
export function readCachedProvidersWrittenAt(): Date | null {
  try {
    const file = cacheFile();
    if (!fs.existsSync(file)) return null;
    const cached = JSON.parse(fs.readFileSync(file, "utf-8"));
    return typeof cached?.timestamp === "number"
      ? new Date(cached.timestamp)
      : null;
  } catch {
    return null;
  }
}

/**
 * A model's reasoning-effort options straight off the in-memory/disk cache
 * `readCachedProviders` already reads for provider identity — synchronous
 * and network-free on purpose. `buildGenerateOptions` calls this on every
 * single model request; routing it through the TTL-respecting async
 * `getProviderModels` path would put a network round trip on freecode's
 * hottest path, which is exactly the kind of per-call latency this whole
 * effort-tuning feature exists to cut. A stale answer here is still better
 * than a live one that cost the request a few hundred extra milliseconds.
 *
 * Exact match first, then case-insensitive — same lookup shape as
 * `findModelLimit`/`modelSupportsImages`.
 */
export function findModelReasoningOptions(
  providerId: string,
  modelId: string,
): readonly ReasoningOption[] | undefined {
  const providers = readCachedProviders();
  const provider = providers?.find((p) => p.id === providerId);
  if (!provider) return undefined;
  const exact = provider.models.find((m) => m.id === modelId);
  if (exact) return exact.reasoningOptions;
  const lower = modelId.toLowerCase();
  return provider.models.find((m) => m.id.toLowerCase() === lower)
    ?.reasoningOptions;
}

function findModelSync(
  providerId: string,
  modelId: string,
): ProviderModel | undefined {
  const providers = readCachedProviders();
  const provider = providers?.find((p) => p.id === providerId);
  if (!provider) return undefined;
  const exact = provider.models.find((m) => m.id === modelId);
  if (exact) return exact;
  const lower = modelId.toLowerCase();
  return provider.models.find((m) => m.id.toLowerCase() === lower);
}

/**
 * Whether `providerId/modelId` accepts a `temperature` parameter, straight
 * off the same synchronous cache `findModelReasoningOptions` reads — same
 * hot-path reasoning: `buildGenerateOptions` is sync, and this must not add
 * a network round trip to every request. Unknown model or no opinion from
 * models.dev both default to `true` (the existing, pre-this-change
 * behavior) — this can only ever suppress the field, never add it where it
 * wasn't already being sent.
 */
export function modelSupportsTemperature(
  providerId: string,
  modelId: string,
): boolean {
  return findModelSync(providerId, modelId)?.temperature !== false;
}

/**
 * Whether `providerId/modelId` can be sent tool definitions at all. Same
 * fail-open-on-unknown rule as `modelSupportsTemperature` — this is for
 * models.dev's `tool_call: false`, not for freecode's own tool-use gating
 * (permission modes, `agentMode`), which stays exactly as it is.
 */
export function modelSupportsToolCalls(
  providerId: string,
  modelId: string,
): boolean {
  return findModelSync(providerId, modelId)?.toolCall !== false;
}

/**
 * One attempt: GET the catalogue as text, or throw. `undefined` body means a
 * 304 — `etag` sent and the server confirmed nothing changed, same
 * conditional-request shape opencode's own models.dev client uses (its
 * `fetchPath`, `packages/core/src/models-dev.ts`).
 *
 * `fetch` rather than `https.get` — it carries a real timeout via
 * `AbortSignal.timeout` instead of the socket-timeout dance, and it honours
 * whatever protocol `FREECODE_MODELS_URL` names. That matters: an internal
 * mirror for an air-gapped install is as likely to be plain http on a private
 * network as it is to be https.
 */
async function fetchOnce(
  url: string,
  etag?: string,
): Promise<{ body: string | undefined; etag?: string }> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(fetchTimeoutMs()),
    headers: {
      accept: "application/json",
      ...(etag ? { "if-none-match": etag } : {}),
    },
  });
  if (res.status === 304) return { body: undefined, etag };
  if (!res.ok) {
    throw new Error(`models.dev returned ${res.status}`);
  }
  return { body: await res.text(), etag: res.headers.get("etag") ?? undefined };
}

/** `undefined` providers means a 304 — the caller's existing cache still
 *  holds the current catalogue. */
async function fetchFromNetwork(
  etag?: string,
): Promise<{ providers: Provider[] | undefined; etag?: string }> {
  const url = modelsUrl();
  let lastError: unknown;
  let result: { body: string | undefined; etag?: string } | undefined;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      result = await fetchOnce(url, etag);
      break;
    } catch (err) {
      lastError = err;
      // Exponential backoff, so a provider having a bad second is not treated
      // the same as one that is down.
      if (attempt < FETCH_ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      }
    }
  }
  if (result === undefined) throw lastError;
  if (result.body === undefined) return { providers: undefined, etag: result.etag };
  return { providers: parseCatalogue(result.body), etag: result.etag };
}

/**
 * `modelData.reasoning_options` -> `ReasoningOption[]`, dropping anything
 * that doesn't match a recognized `type` rather than throwing — models.dev
 * is a third party, and a field it adds or reshapes later should degrade to
 * "no options" here, not take the whole provider list down with it. For an
 * "effort" entry, `null`/"null" values are filtered the same way opencode's
 * own ingestion does (models.dev's effort arrays use a literal null to mark
 * an unsupported slot in some models' lists).
 */
function parseReasoningOptions(raw: unknown): ReasoningOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const options: ReasoningOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const type = (entry as any).type;
    if (type === "effort") {
      const values = Array.isArray((entry as any).values)
        ? (entry as any).values.filter(
            (v: unknown): v is string =>
              typeof v === "string" && v !== "null",
          )
        : [];
      options.push({ type: "effort", values });
    } else if (type === "toggle") {
      options.push({ type: "toggle" });
    } else if (type === "budget_tokens") {
      options.push({
        type: "budget_tokens",
        min: typeof (entry as any).min === "number" ? (entry as any).min : undefined,
        max: typeof (entry as any).max === "number" ? (entry as any).max : undefined,
      });
    }
  }
  return options.length > 0 ? options : undefined;
}

/** models.dev's api.json -> the shape the rest of freecode reads. */
function parseCatalogue(body: string): Provider[] {
  const raw = JSON.parse(body);
  const providers: Provider[] = [];

  for (const [rawProviderId, providerData] of Object.entries(raw)) {
    const p = providerData as any;
    if (!p || !p.models) continue;
    // models.dev calls Google's provider "google"; freecode's ids
    // are its own (pricing keys, config.json, rollout history), so
    // the rename happens here at the boundary. The table lives in
    // providers/catalogue.ts — a second copy of it here is how one
    // rename becomes two vocabularies again, which is the bug this
    // whole subsystem exists to have ended.
    const providerId = canonicalProviderId(rawProviderId);

    const models: ProviderModel[] = [];
    for (const [modelId, modelData] of Object.entries(
      p.models as Record<string, any>,
    )) {
      if (!modelData) continue;
      models.push({
        id: modelId,
        name: modelData.name || modelId,
        description: modelData.description || modelData.name || modelId,
        limit:
          modelData.limit && typeof modelData.limit.context === "number"
            ? {
                context: modelData.limit.context,
                output: modelData.limit.output ?? 0,
              }
            : undefined,
        cost:
          modelData.cost &&
          typeof modelData.cost.input === "number" &&
          typeof modelData.cost.output === "number"
            ? {
                input: modelData.cost.input,
                output: modelData.cost.output,
                cacheRead:
                  typeof modelData.cost.cache_read === "number"
                    ? modelData.cost.cache_read
                    : undefined,
                cacheWrite:
                  typeof modelData.cost.cache_write === "number"
                    ? modelData.cost.cache_write
                    : undefined,
              }
            : undefined,
        inputModalities: Array.isArray(modelData.modalities?.input)
          ? (modelData.modalities.input as string[])
          : undefined,
        reasoning:
          typeof modelData.reasoning === "boolean"
            ? modelData.reasoning
            : undefined,
        reasoningOptions: parseReasoningOptions(modelData.reasoning_options),
        temperature:
          typeof modelData.temperature === "boolean"
            ? modelData.temperature
            : undefined,
        toolCall:
          typeof modelData.tool_call === "boolean"
            ? modelData.tool_call
            : undefined,
      });
    }

    providers.push({
      id: providerId,
      name: p.name || providerId,
      description: p.description || p.name || providerId,
      models,
      ...(typeof p.npm === "string" ? { npm: p.npm } : {}),
      ...(typeof p.api === "string" ? { api: p.api } : {}),
      ...(Array.isArray(p.env) ? { env: p.env as string[] } : {}),
    });
  }

  return providers;
}

export async function getProviders(forceRefresh = false): Promise<Provider[]> {
  if (!forceRefresh && cache) {
    return cache.data;
  }

  const diskCache = loadFromDisk();
  if (diskCache && !forceRefresh) {
    cache = { data: diskCache, timestamp: Date.now() };
    return cache.data;
  }

  // A stale (TTL-expired) disk cache still carries a usable `etag` — sending
  // it means models.dev answers 304 and we skip re-downloading and
  // re-parsing the multi-MB catalogue for a body that didn't change.
  const staleCache = diskCache ? null : loadRawFromDisk();
  const priorEtag = forceRefresh ? undefined : staleCache?.etag;

  try {
    const { providers, etag } = await fetchFromNetwork(priorEtag);
    if (providers === undefined) {
      // 304: reuse the unchanged body, but refresh the timestamp so the next
      // check doesn't immediately refetch, and re-save with the (possibly
      // rotated) etag.
      const unchanged = staleCache!.data;
      cache = { data: unchanged, timestamp: Date.now(), etag };
      saveToDisk(unchanged, etag);
      return unchanged;
    }
    cache = { data: providers, timestamp: Date.now(), etag };
    saveToDisk(providers, etag);
    return providers;
  } catch (err) {
    // If network fails but we have disk cache, use it
    const fallback = diskCache ?? staleCache?.data;
    if (fallback) {
      cache = { data: fallback, timestamp: Date.now() };
      return cache.data;
    }
    throw err;
  }
}

export async function getProviderModels(
  providerId: string,
): Promise<ProviderModel[]> {
  const providers = await getProviders();
  const provider = providers.find((p) => p.id === providerId);
  return provider?.models || [];
}

/**
 * The single source of truth for a model's context-window size. Reads the
 * limit models.dev reports for `providerId/modelId`; frontends call this over
 * IPC (`models.contextLimit`) instead of hardcoding their own tables.
 *
 * Matching is exact first, then case-insensitive on the model id, since
 * provider/model ids from config vary in casing. Returns `0` when the model
 * is unknown so callers can hide a context meter rather than divide by zero.
 */
export async function getModelContextLimit(
  providerId: string,
  modelId: string,
): Promise<number> {
  return (await findModelLimit(providerId, modelId))?.context ?? 0;
}

/**
 * The model's maximum reply length, as reported by models.dev. Returns `0`
 * when unknown so callers can fall back rather than reserve nothing.
 */
export async function getModelOutputLimit(
  providerId: string,
  modelId: string,
): Promise<number> {
  return (await findModelLimit(providerId, modelId))?.output ?? 0;
}

/**
 * How many tokens to reserve for the reply on a request to `providerId/modelId`.
 *
 * Providers charge `max_tokens` against the same context window as the input,
 * so this number is subtracted twice over: once from what the conversation may
 * occupy, and again by the API when it validates the request. It must
 * therefore be the *same* value at both sites — sending one number while
 * budgeting against another is how a session ends up rejected at a threshold
 * it believed it was under.
 *
 * The model's own ceiling wins when it is lower than the cap; an unknown model
 * (limit 0) falls back to the cap rather than reserving nothing.
 */
export async function resolveMaxOutputTokens(
  providerId: string,
  modelId: string | undefined,
): Promise<number> {
  if (!modelId) return OUTPUT_TOKEN_CAP;
  const limit = await getModelOutputLimit(providerId, modelId).catch(() => 0);
  return Math.min(limit || OUTPUT_TOKEN_CAP, OUTPUT_TOKEN_CAP);
}

// Exact match first, then case-insensitive: provider/model ids from config
// vary in casing.
async function findModelLimit(
  providerId: string,
  modelId: string,
): Promise<ModelLimit | undefined> {
  const models = await getProviderModels(providerId);
  const exact = models.find((m) => m.id === modelId);
  if (exact) return exact.limit;
  const lower = modelId.toLowerCase();
  return models.find((m) => m.id.toLowerCase() === lower)?.limit;
}

/**
 * Whether a model accepts image input. Vision is a *model* capability, not a
 * provider one — anthropic ships text-only models and some text-first
 * providers ship vision models — so this reads models.dev per model rather
 * than keeping a hardcoded provider allowlist.
 *
 * Unknown models return false: sending an image part to a text-only model is
 * a hard 400 from the provider, so failing closed with a message the user can
 * act on beats a request that dies on the wire.
 */
export async function modelSupportsImages(
  providerId: string,
  modelId: string | undefined,
): Promise<boolean> {
  if (!modelId) return false;
  const models = await getProviderModels(providerId).catch(() => []);
  const lower = modelId.toLowerCase();
  const match =
    models.find((m) => m.id === modelId) ??
    models.find((m) => m.id.toLowerCase() === lower);
  return match?.inputModalities?.includes("image") ?? false;
}
