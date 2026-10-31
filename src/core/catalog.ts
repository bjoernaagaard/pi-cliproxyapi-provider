import type {
  Model,
  ModelPromptCache,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { resolveEndpoints } from "./connection.ts";
import { matchModelCost, ZERO_COST } from "./costs.ts";
import type { CostCatalog } from "./costs.ts";

export type CliproxyApi =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions";

export type ThoughtSummary = "omitted" | "summarized";

export type ModelFamilies = Readonly<Record<string, CliproxyApi>>;

/**
 * Family patterns. The wildcard is the fallback regardless of table order.
 * Kimi uses Anthropic Messages. On Responses CLIProxyAPI rejects its
 * prompt_cache_retention, and on Chat Completions it rejects the developer
 * role pi-ai sends for system prompts. Messages takes both and caches.
 */
export const MODEL_API_BY_FAMILY = {
  "*": "openai-responses",
  "claude-*": "anthropic-messages",
  "kimi-*": "anthropic-messages",
} satisfies ModelFamilies;

const OptionalString = Type.Optional(Type.String());
const OptionalNumber = Type.Optional(Type.Number());
const EffortName = Type.String();

export const CatalogModelSchema = Type.Object({
  additional_speed_tiers: Type.Optional(Type.Array(Type.String())),
  context_window: OptionalNumber,
  cpa_capabilities: Type.Optional(
    Type.Object({
      web_search: Type.Optional(Type.Boolean()),
    })
  ),
  default_service_tier: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  description: OptionalString,
  display_name: OptionalString,
  id: OptionalString,
  input_modalities: Type.Optional(Type.Array(Type.String())),
  max_completion_tokens: OptionalNumber,
  max_context_window: OptionalNumber,
  max_output_tokens: OptionalNumber,
  max_tokens: OptionalNumber,
  name: OptionalString,
  service_tiers: Type.Optional(
    Type.Array(
      Type.Union([
        Type.String(),
        Type.Object({
          description: OptionalString,
          id: OptionalString,
          name: OptionalString,
        }),
      ])
    )
  ),
  slug: OptionalString,
  supported_reasoning_levels: Type.Optional(
    Type.Array(
      Type.Union([
        EffortName,
        Type.Object({ description: OptionalString, effort: OptionalString }),
      ])
    )
  ),
  supports_reasoning_effort_updates: Type.Optional(Type.Boolean()),
  visibility: OptionalString,
});

export type CatalogModel = Static<typeof CatalogModelSchema>;

const CatalogEntries = Type.Array(CatalogModelSchema);

const CatalogEnvelope = Type.Union([
  CatalogEntries,
  Type.Object({ models: CatalogEntries }),
  Type.Object({ data: CatalogEntries }),
]);

export interface CliproxyModel extends Model<CliproxyApi> {
  thoughtSummary: ThoughtSummary;
  supportsFast: boolean;
  supportsWebSearch?: boolean;
  supportsReasoningEffortUpdates?: boolean;
  thinkingLevelMap?: ThinkingLevelMap & { ultra?: string | null };
  stale?: boolean;
  lastSeenAt?: number;
  staleSince?: number;
}

export interface MappingOptions {
  baseUrl: string;
  providerId?: string;
  families?: ModelFamilies;
  costs?: CostCatalog;
  fast?: () => boolean;
  thoughtSummaries?: Readonly<Record<string, ThoughtSummary>>;
  /** Prompt cache lifetimes by model id. Core has no built-in numbers. */
  promptCache?: (id: string) => ModelPromptCache | undefined;
}

export interface MappedCatalog {
  models: CliproxyModel[];
  fastModelIds: string[];
}

export interface CatalogFetchOptions {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface MergeOptions {
  now?: number;
  staleTtlMs?: number;
}

export const DEFAULT_MODEL_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const selectModelApi = (
  id: string,
  families: ModelFamilies = MODEL_API_BY_FAMILY
): CliproxyApi => {
  const modelId = id.trim().toLowerCase();
  // Prefixed aliases (<channel>/<model>, e.g. devin/claude-fable-5-1) hide
  // the family at the start, so also match the segment after the last "/".
  // Full-id matches win, so an explicit prefixed pattern still takes over.
  const segment = modelId.slice(modelId.lastIndexOf("/") + 1);
  const candidates = segment === modelId ? [modelId] : [modelId, segment];

  for (const candidate of candidates) {
    for (const [pattern, api] of Object.entries(families)) {
      if (pattern === "*") {
        continue;
      }

      if (
        pattern.endsWith("*")
          ? candidate.startsWith(pattern.slice(0, -1))
          : candidate === pattern
      ) {
        return api;
      }
    }
  }

  return families["*"] ?? "openai-responses";
};

const thinkingMap = (efforts: string[]): CliproxyModel["thinkingLevelMap"] => {
  if (efforts.length === 0) {
    return undefined;
  }

  const map: NonNullable<CliproxyModel["thinkingLevelMap"]> = {};

  for (const level of THINKING_LEVELS) {
    const effort = level === "off" ? "none" : level;
    map[level] = efforts.includes(effort) ? effort : null;
  }

  return map;
};

const positive = (...values: (number | undefined)[]): number | undefined =>
  values.find(
    (value) => value !== undefined && Number.isFinite(value) && value > 0
  );

const capabilities = (entry: CatalogModel) => {
  const efforts = (entry.supported_reasoning_levels ?? [])
    .map((level) => {
      const effort = Value.Check(EffortName, level)
        ? level
        : (level.effort ?? "");

      return effort.trim().toLowerCase();
    })
    .filter(Boolean);

  const input: ("text" | "image")[] = [];

  for (const modality of entry.input_modalities ?? []) {
    const value = modality.trim().toLowerCase();

    if ((value === "text" || value === "image") && !input.includes(value)) {
      input.push(value);
    }
  }

  if (!input.includes("text")) {
    input.unshift("text");
  }

  return {
    contextWindow:
      positive(entry.context_window, entry.max_context_window) ?? 128_000,
    input,
    maxTokens:
      positive(
        entry.max_tokens,
        entry.max_output_tokens,
        entry.max_completion_tokens
      ) ?? 16_384,
    reasoning: efforts.some((effort) => effort !== "none"),
    thinkingLevelMap: thinkingMap(efforts),
  };
};

const webSearchCapability = (
  entry: CatalogModel
): { supportsWebSearch?: boolean } =>
  entry.cpa_capabilities?.web_search === undefined
    ? {}
    : { supportsWebSearch: entry.cpa_capabilities.web_search };

/** Read once per mapping, so every model in one catalog gets the same tier. */
const readFast = (options: MappingOptions): boolean =>
  options.fast?.() ?? false;

const addAnthropicSettings = (
  model: CliproxyModel,
  options: MappingOptions
): void => {
  // pi-ai sends the session id as X-Session-Affinity only when asked.
  // CLIProxyAPI's session affinity reads it to keep a session, and the
  // prompt cache, on one upstream account. Responses always sends one.
  model.compat = { sendSessionAffinityHeaders: true };

  // pi warms the prompt cache only for models that declare its lifetimes.
  const promptCache = options.promptCache?.(model.id);

  if (promptCache) {
    model.promptCache = promptCache;
  }
};

export const mapCatalog = (
  entries: readonly CatalogModel[],
  options: MappingOptions
): MappedCatalog => {
  const endpoints = resolveEndpoints(options.baseUrl);
  const models = new Map<string, CliproxyModel>();
  const fastPricing = readFast(options);

  for (const entry of entries) {
    const id = (entry.slug ?? entry.id ?? "").trim();

    if (!id || entry.visibility?.toLowerCase() === "hide") {
      continue;
    }

    const api = selectModelApi(id, options.families);

    const supportsFast = (entry.service_tiers?.length ?? 0) > 0;

    const model: CliproxyModel = {
      ...capabilities(entry),
      api,
      baseUrl:
        api === "anthropic-messages"
          ? endpoints.anthropicBaseUrl
          : endpoints.openaiBaseUrl,
      cost: options.costs
        ? matchModelCost(
            id,
            options.costs,
            fastPricing && supportsFast && api === "openai-responses"
          )
        : { ...ZERO_COST },
      id,
      name: (entry.display_name ?? entry.name ?? id).trim() || id,
      provider: options.providerId ?? "cliproxyapi",
      supportsFast,
      supportsReasoningEffortUpdates:
        entry.supports_reasoning_effort_updates === true,
      thoughtSummary: options.thoughtSummaries?.[id] ?? "omitted",
      ...webSearchCapability(entry),
    };

    if (api === "anthropic-messages") {
      addAnthropicSettings(model, options);
    }

    models.set(id, model);
  }

  const result = [...models.values()];

  return {
    fastModelIds: result.flatMap((model) =>
      model.supportsFast ? [model.id] : []
    ),
    models: result,
  };
};

export class CatalogHttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string) {
    super(`Catalog request failed: ${status} ${statusText}`);
    this.name = "CatalogHttpError";
    this.status = status;
  }
}

export const fetchCatalog = async (
  options: CatalogFetchOptions
): Promise<CatalogModel[]> => {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);

  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  const response = await (options.fetch ?? globalThis.fetch)(
    resolveEndpoints(options.baseUrl).modelsUrl,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      signal,
    }
  );

  if (!response.ok) {
    throw new CatalogHttpError(response.status, response.statusText);
  }

  const payload: unknown = await response.json();

  if (!Value.Check(CatalogEnvelope, payload)) {
    throw new TypeError(
      "Invalid model catalog: expected an array, models, or data of catalog entries"
    );
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  return "models" in payload ? payload.models : payload.data;
};

/**
 * Drops models the latest catalog no longer lists. mergeCatalog keeps them so
 * a session that uses one still resolves, but nobody should pick one anew.
 */
export const withoutStale = <T extends object>(models: readonly T[]): T[] =>
  models.filter((model) => !("stale" in model && model.stale === true));

export const mergeCatalog = (
  previous: readonly CliproxyModel[],
  fresh: readonly CliproxyModel[],
  options: MergeOptions = {}
): CliproxyModel[] => {
  const now = options.now ?? Date.now();
  const ttl = options.staleTtlMs ?? DEFAULT_MODEL_STALE_TTL_MS;
  const merged = new Map<string, CliproxyModel>();

  for (const model of fresh) {
    const updated = { ...model, lastSeenAt: now, stale: false };
    delete updated.staleSince;
    merged.set(model.id, updated);
  }

  for (const model of previous) {
    if (merged.has(model.id)) {
      continue;
    }

    const lastSeenAt = model.lastSeenAt ?? now;
    const staleSince = model.stale ? (model.staleSince ?? lastSeenAt) : now;

    if (now - staleSince < ttl) {
      merged.set(model.id, { ...model, lastSeenAt, stale: true, staleSince });
    }
  }

  return [...merged.values()];
};
