import type {
  ModelCost,
  ModelCostRates,
  ModelCostTier,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export interface CostEntry {
  providerId: string;
  modelId: string;
  standard: ModelCost;
  fast?: ModelCost;
}

export interface CostCatalog {
  exact: Map<string, CostEntry[]>;
  normalized: Map<string, CostEntry[]>;
}

export interface CostFetchOptions {
  url?: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  /** fetchCosts only: returned instead of an empty catalog when the fetch fails. */
  fallback?: CostCatalog;
  /** fetchCostsConditional only: sent as If-None-Match, so an unchanged catalog answers 304. */
  etag?: string;
  /** Defaults to 10 s. */
  timeoutMs?: number;
}

export type CostFetchResult =
  | { status: "fresh"; costs: CostCatalog; etag?: string }
  | { status: "not-modified" }
  /** `reason` is short enough for a notice: "timeout", "HTTP 503", "invalid catalog" or a network error. */
  | { status: "failed"; reason: string };

/** Prices for one catalog id. Null means models.dev has no price for it. */
export type ResolvedPrice = { standard: ModelCost; fast?: ModelCost } | null;

/** Resolved prices by catalog id. */
export type ResolvedPrices = Record<string, ResolvedPrice>;

export const DEFAULT_COSTS_URL = "https://models.dev/api.json";

const DEFAULT_COSTS_TIMEOUT_MS = 10_000;

/** Every resolved price is stored under this provider id, so lookups use selectEntry's single-variant branch. */
const RESOLVED_PROVIDER_ID = "resolved";

export const ZERO_COST = {
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
} as const;

const NAMESPACE =
  /^(?<provider>openai|anthropic|google(?:-vertex)?|xai|deepseek|mistral|cohere|zhipuai|moonshotai|minimax|meta)[/:.]/iu;

const NON_ALPHANUMERIC = /[^a-z0-9]/gu;

const PROVIDER_PREFERENCES = [
  {
    pattern: /^(?:gpt-|o[134](?:-|$)|chatgpt-|codex-)/u,
    providers: ["openai", "openai-codex", "opencode"],
  },
  { pattern: /^claude-/u, providers: ["anthropic"] },
  { pattern: /^(?:gemini-|gemma-)/u, providers: ["google", "google-vertex"] },
  { pattern: /^grok-/u, providers: ["xai"] },
  { pattern: /^deepseek-/u, providers: ["deepseek"] },
  { pattern: /^mistral-/u, providers: ["mistral"] },
  { pattern: /^command-/u, providers: ["cohere"] },
  { pattern: /^glm-/u, providers: ["zhipuai"] },
  { pattern: /^(?:kimi-|moonshot-)/u, providers: ["moonshotai"] },
  { pattern: /^minimax-/u, providers: ["minimax"] },
  { pattern: /^(?:llama-|muse-)/u, providers: ["meta"] },
];

const PRICE_ALIASES = new Map<string, readonly string[]>(
  Object.entries({
    "gemini-3-flash-agent": ["gemini-3.5-flash"],
    "gemini-3.1-pro-low": ["gemini-3.1-pro-preview"],
    "gemini-3.6-flash-high": ["gemini-3.6-flash"],
    "gemini-pro-agent": ["gemini-3.1-pro-preview"],
    "grok-3-mini": ["xai/grok-3-mini"],
    "grok-composer-2.5-fast": ["grok-4.3"],
  })
);

const Rate = Type.Optional(Type.Number());

const RateFields = {
  cacheRead: Rate,
  cacheWrite: Rate,
  cache_read: Rate,
  cache_write: Rate,
  input: Rate,
  output: Rate,
};

const RatesSchema = Type.Object(RateFields);

const TierSchema = Type.Object({
  ...RateFields,
  inputTokensAbove: Rate,
  tier: Type.Optional(
    Type.Object({ size: Rate, type: Type.Optional(Type.String()) })
  ),
});

const CostSchema = Type.Object({
  ...RateFields,
  context_over_200k: Type.Optional(TierSchema),
  tiers: Type.Optional(Type.Array(TierSchema)),
});

const ModelEntrySchema = Type.Object({
  cost: Type.Optional(CostSchema),
  experimental: Type.Optional(
    Type.Object({
      modes: Type.Optional(
        Type.Object({
          fast: Type.Optional(Type.Object({ cost: Type.Optional(CostSchema) })),
        })
      ),
    })
  ),
});

const ProviderSchema = Type.Object({
  models: Type.Record(Type.String(), Type.Unknown()),
});

const NetworkErrorSchema = Type.Object({
  cause: Type.Object({ code: Type.String() }),
});

/** models.dev api.json. Each provider and model is checked on its own, so one odd entry never hides the rest. */
export const ModelsDevCatalogSchema = Type.Record(
  Type.String(),
  Type.Unknown()
);

export type ModelsDevCatalog = Static<typeof ModelsDevCatalogSchema>;

type Rates = Static<typeof RatesSchema>;

type Tier = Static<typeof TierSchema>;

type Cost = Static<typeof CostSchema>;

const readRates = (
  source: Rates,
  fallback: ModelCostRates
): ModelCostRates => ({
  cacheRead: source.cacheRead ?? source.cache_read ?? fallback.cacheRead,
  cacheWrite: source.cacheWrite ?? source.cache_write ?? fallback.cacheWrite,
  input: source.input ?? fallback.input,
  output: source.output ?? fallback.output,
});

const parseCost = (source: Cost | undefined): ModelCost | undefined => {
  if (!source || (source.input === undefined && source.output === undefined)) {
    return undefined;
  }

  const cost: ModelCost = readRates(source, ZERO_COST);
  const tiers = new Map<number, ModelCostTier>();

  const addTier = (tier: Tier | undefined, fallbackThreshold?: number) => {
    if (!tier) {
      return;
    }

    const descriptor = tier.tier;

    if (descriptor?.type !== undefined && descriptor.type !== "context") {
      return;
    }

    const threshold =
      tier.inputTokensAbove ?? descriptor?.size ?? fallbackThreshold;

    if (threshold === undefined || threshold <= 0) {
      return;
    }

    tiers.set(threshold, {
      ...readRates(tier, cost),
      inputTokensAbove: threshold,
    });
  };

  for (const tier of source.tiers ?? []) {
    addTier(tier);
  }

  if (tiers.size === 0) {
    addTier(source.context_over_200k, 200_000);
  }

  if (tiers.size > 0) {
    cost.tiers = [...tiers.values()].toSorted(
      (left, right) => left.inputTokensAbove - right.inputTokensAbove
    );
  }

  return cost;
};

const stripNamespace = (modelId: string): string =>
  modelId.trim().toLowerCase().replace(NAMESPACE, "");

const normalizedKey = (modelId: string): string =>
  stripNamespace(modelId).replaceAll(NON_ALPHANUMERIC, "");

const addEntry = (
  index: Map<string, CostEntry[]>,
  key: string,
  entry: CostEntry
): void => {
  if (!key) {
    return;
  }

  const entries = index.get(key) ?? [];

  if (
    entries.some(
      (candidate) =>
        candidate.modelId === entry.modelId &&
        candidate.providerId === entry.providerId
    )
  ) {
    return;
  }

  entries.push(entry);
  index.set(key, entries);
};

export const parseCosts = (payload: ModelsDevCatalog): CostCatalog => {
  const catalog: CostCatalog = { exact: new Map(), normalized: new Map() };

  for (const [providerId, provider] of Object.entries(payload)) {
    if (!Value.Check(ProviderSchema, provider)) {
      continue;
    }

    for (const [modelId, model] of Object.entries(provider.models)) {
      if (!Value.Check(ModelEntrySchema, model)) {
        continue;
      }

      const standard = parseCost(model.cost);

      if (!standard) {
        continue;
      }

      const fast = parseCost(model.experimental?.modes?.fast?.cost);
      const entry = { fast, modelId, providerId, standard };
      const rawId = modelId.trim().toLowerCase();

      for (const key of new Set([rawId, stripNamespace(rawId)])) {
        addEntry(catalog.exact, key, entry);
      }

      addEntry(catalog.normalized, normalizedKey(rawId), entry);
    }
  }

  return catalog;
};

const selectEntry = (
  entries: readonly CostEntry[],
  modelId: string
): CostEntry | undefined => {
  const raw = modelId.trim().toLowerCase();
  const namespace = raw.match(NAMESPACE)?.groups?.provider;

  const family = PROVIDER_PREFERENCES.find(({ pattern }) =>
    pattern.test(stripNamespace(raw))
  );

  for (const provider of [namespace, ...(family?.providers ?? [])]) {
    const match = entries.find((entry) => entry.providerId === provider);

    if (match) {
      return match;
    }
  }

  const variants = new Set(
    entries.map((entry) =>
      JSON.stringify({ fast: entry.fast, standard: entry.standard })
    )
  );

  if (variants.size === 1) {
    return entries.toSorted((left, right) =>
      left.providerId.localeCompare(right.providerId)
    )[0];
  }

  return undefined;
};

const findCostEntry = (
  modelId: string,
  catalog: CostCatalog
): CostEntry | undefined => {
  const rawId = modelId.trim().toLowerCase();

  for (const id of [rawId, ...(PRICE_ALIASES.get(rawId) ?? [])]) {
    const entry =
      selectEntry(catalog.exact.get(id) ?? [], id) ??
      selectEntry(catalog.exact.get(stripNamespace(id)) ?? [], id) ??
      selectEntry(catalog.normalized.get(normalizedKey(id)) ?? [], id);

    if (entry) {
      return entry;
    }
  }

  return undefined;
};

export const matchModelCost = (
  modelId: string,
  catalog: CostCatalog,
  fast = false
): ModelCost => {
  const entry = findCostEntry(modelId, catalog);

  if (!entry) {
    return { ...ZERO_COST };
  }

  return structuredClone(fast && entry.fast ? entry.fast : entry.standard);
};

/** Resolves each id once against the full catalog, so only these few prices need to be kept. */
export const resolvePrices = (
  ids: readonly string[],
  catalog: CostCatalog
): ResolvedPrices => {
  const priceOf = (id: string): ResolvedPrice => {
    const entry = findCostEntry(id, catalog);

    if (!entry) {
      return null;
    }

    return structuredClone(
      entry.fast
        ? { fast: entry.fast, standard: entry.standard }
        : { standard: entry.standard }
    );
  };

  return Object.fromEntries(ids.map((id) => [id, priceOf(id)]));
};

/** A catalog that prices exactly the resolved ids. Each id has one entry, so matchModelCost returns it as is. */
export const costCatalogFromPrices = (prices: ResolvedPrices): CostCatalog => {
  const catalog: CostCatalog = { exact: new Map(), normalized: new Map() };

  for (const [modelId, price] of Object.entries(prices)) {
    if (price) {
      addEntry(catalog.exact, modelId.trim().toLowerCase(), {
        ...price,
        modelId,
        providerId: RESOLVED_PROVIDER_ID,
      });
    }
  }

  return catalog;
};

const isCatalog = (payload: unknown): payload is ModelsDevCatalog =>
  Value.Check(ModelsDevCatalogSchema, payload) &&
  Object.values(payload).some((provider) =>
    Value.Check(ProviderSchema, provider)
  );

/**
 * Fetches the models.dev catalog, sending `etag` as If-None-Match. Reports a
 * models.dev failure as a result instead of throwing. Throws only when the
 * caller's own signal aborts.
 */
export const fetchCostsConditional = async (
  options: CostFetchOptions = {}
): Promise<CostFetchResult> => {
  const timeout = AbortSignal.timeout(
    options.timeoutMs ?? DEFAULT_COSTS_TIMEOUT_MS
  );

  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  try {
    const response = await (options.fetch ?? globalThis.fetch)(
      options.url ?? DEFAULT_COSTS_URL,
      {
        headers: options.etag ? { "If-None-Match": options.etag } : {},
        signal,
      }
    );

    if (response.status === 304) {
      await response.body?.cancel();

      return { status: "not-modified" };
    }

    if (!response.ok) {
      await response.body?.cancel();

      return { reason: `HTTP ${response.status}`, status: "failed" };
    }

    const payload: unknown = await response.json();

    if (!isCatalog(payload)) {
      return { reason: "invalid catalog", status: "failed" };
    }

    return {
      costs: parseCosts(payload),
      etag: response.headers.get("etag") ?? undefined,
      status: "fresh",
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw error;
    }

    if (timeout.aborted) {
      return { reason: "timeout", status: "failed" };
    }

    if (error instanceof SyntaxError) {
      return { reason: "invalid catalog", status: "failed" };
    }

    // Node's fetch names the network failure, such as ENOTFOUND, in the cause's code.
    return {
      reason: Value.Check(NetworkErrorSchema, error)
        ? `network error ${error.cause.code}`
        : "network error",
      status: "failed",
    };
  }
};

/** The whole catalog, or `fallback` (empty by default) when models.dev fails. For callers without a price cache. */
export const fetchCosts = async (
  options: CostFetchOptions = {}
): Promise<CostCatalog> => {
  const result = await fetchCostsConditional({
    fetch: options.fetch,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    url: options.url,
  });

  return result.status === "fresh"
    ? result.costs
    : (options.fallback ?? { exact: new Map(), normalized: new Map() });
};
