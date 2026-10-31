/**
 * Public core API (no filesystem or ambient credential reads).
 * resolveEndpoints(baseUrl: string): Endpoints
 * resolveConnection(env: Readonly<Record<string, string | undefined>>, file?: ConnectionValues, stored?: ConnectionValues): ResolvedConnection | null
 * resolveConnectionSources(env: Readonly<Record<string, string | undefined>>, file?: ConnectionValues, stored?: ConnectionValues): ConnectionSources
 * selectModelApi(id: string, families?: ModelFamilies): CliproxyApi
 * fetchCatalog(options: CatalogFetchOptions): Promise<CatalogModel[]>
 * fetchCosts(options?: CostFetchOptions): Promise<CostCatalog>
 * fetchCostsConditional(options?: CostFetchOptions): Promise<CostFetchResult>
 * resolvePrices(ids: readonly string[], catalog: CostCatalog): ResolvedPrices
 * costCatalogFromPrices(prices: ResolvedPrices): CostCatalog
 * parseCosts(payload: ModelsDevCatalog): CostCatalog
 * matchModelCost(modelId: string, catalog: CostCatalog, fast?: boolean): ModelCost
 * mapCatalog(entries: readonly CatalogModel[], options: MappingOptions): MappedCatalog
 * mergeCatalog(previous: readonly CliproxyModel[], fresh: readonly CliproxyModel[], options?: MergeOptions): CliproxyModel[]
 * withoutStale<T extends object>(models: readonly T[]): T[]
 * wrapCliproxyStreams(streams: ProviderStreams, settings: PayloadSettings): ProviderStreams
 * createCliproxyProvider(options: CliproxyProviderOptions): Provider<CliproxyApi>
 * quotaResetFromError(message: string, now?: number, fallbackAt?: number): number | undefined
 * startOAuth(options: StartOAuthOptions): Promise<OAuthStart>
 * submitOAuthCallback(options: SubmitOAuthCallbackOptions): Promise<OAuthStatus>
 * pollOAuthStatus(options: PollOAuthStatusOptions): Promise<OAuthStatus>
 * fetchUsage(options: UsageFetchOptions): Promise<ProviderUsage[]>
 * resetCooldowns(options: ResetCooldownsOptions): Promise<string[]>
 * unavailableModels(usage: readonly ProviderUsage[], exhausted: Readonly<Record<string, number>>, now?: number): Map<string, number>
 */
// pi maps only some pi-ai entry points into extensions. compat re-exports the same lazy API factories.
import {
  anthropicMessagesApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { Provider } from "@earendil-works/pi-ai/models";

import {
  fetchCatalog,
  mapCatalog,
  mergeCatalog,
  withoutStale,
} from "./catalog.ts";
import type { CliproxyApi, CliproxyModel, MappingOptions } from "./catalog.ts";
import { resolveEndpoints } from "./connection.ts";
import { fetchCosts } from "./costs.ts";
import { wrapCliproxyStreams } from "./streams.ts";

export {
  CatalogHttpError,
  DEFAULT_MODEL_STALE_TTL_MS,
  MODEL_API_BY_FAMILY,
  fetchCatalog,
  mapCatalog,
  mergeCatalog,
  selectModelApi,
  withoutStale,
  type CatalogFetchOptions,
  type CatalogModel,
  type CliproxyApi,
  type CliproxyModel,
  type MappedCatalog,
  type MappingOptions,
  type MergeOptions,
  type ModelFamilies,
  type ThoughtSummary,
} from "./catalog.ts";

export {
  DEFAULT_BASE_URL,
  resolveConnection,
  resolveConnectionSources,
  resolveEndpoints,
  type ConnectionSources,
  type ConnectionValues,
  type Endpoints,
  type ResolvedConnection,
  type ValueSource,
} from "./connection.ts";

export {
  DEFAULT_COSTS_URL,
  ZERO_COST,
  costCatalogFromPrices,
  fetchCosts,
  fetchCostsConditional,
  matchModelCost,
  parseCosts,
  resolvePrices,
  type CostCatalog,
  type CostEntry,
  type CostFetchOptions,
  type CostFetchResult,
  type ResolvedPrice,
  type ResolvedPrices,
} from "./costs.ts";

export {
  pollOAuthStatus,
  startOAuth,
  submitOAuthCallback,
  type OAuthRequestOptions,
  type OAuthStart,
  type OAuthStatus,
  type OAuthStatusValue,
  type PollOAuthStatusOptions,
  type StartOAuthOptions,
  type SubmitOAuthCallbackOptions,
} from "./oauth.ts";

export { wrapCliproxyStreams, type PayloadSettings } from "./streams.ts";

export {
  QUOTA_FALLBACK_MS,
  fetchUsage,
  quotaResetFromError,
  resetCooldowns,
  unavailableModels,
  windowLabel,
  type ProviderUsage,
  type ResetCooldownsOptions,
  type UsageFetchOptions,
  type UsageWindow,
} from "./usage.ts";

export interface CliproxyProviderOptions extends MappingOptions {
  apiKey: string;
  providerName?: string;
  /** Static baseline models, available before the first refresh. */
  models?: readonly CliproxyModel[];
  fetch?: typeof globalThis.fetch;
  costsUrl?: string;
  staleTtlMs?: number;
}

export const createCliproxyProvider = (
  options: CliproxyProviderOptions
): Provider<CliproxyApi> => {
  if (!options.apiKey.trim()) {
    throw new Error("CLIProxyAPI apiKey is empty");
  }

  const endpoints = resolveEndpoints(options.baseUrl);
  const id = options.providerId ?? "cliproxyapi";

  const provider: Provider<CliproxyApi> = createProvider<CliproxyApi>({
    api: {
      "anthropic-messages": wrapCliproxyStreams(
        anthropicMessagesApi(),
        options
      ),
      "openai-completions": wrapCliproxyStreams(
        openAICompletionsApi(),
        options
      ),
      "openai-responses": wrapCliproxyStreams(openAIResponsesApi(), options),
    },
    auth: {
      apiKey: {
        name: "CLIProxyAPI API key",
        resolve: () => Promise.resolve({ auth: { apiKey: options.apiKey } }),
      },
    },
    baseUrl: endpoints.rootUrl,
    fetchModels: async ({ signal, baseUrl }) => {
      const root = baseUrl ?? options.baseUrl;

      const [entries, costs] = await Promise.all([
        fetchCatalog({
          apiKey: options.apiKey,
          baseUrl: root,
          fetch: options.fetch,
          signal,
        }),
        options.costs ??
          fetchCosts({ fetch: options.fetch, signal, url: options.costsUrl }),
      ]);

      const mapped = mapCatalog(entries, { ...options, baseUrl: root, costs });

      const previous = provider
        .getModels()
        .filter(
          (model): model is CliproxyModel =>
            "thoughtSummary" in model && "supportsFast" in model
        );

      return mergeCatalog(previous, mapped.models, {
        staleTtlMs: options.staleTtlMs,
      });
    },
    filterModels: (models) => withoutStale(models),
    id,
    models: options.models ?? [],
    name: options.providerName ?? "CLIProxyAPI",
  });

  return provider;
};
