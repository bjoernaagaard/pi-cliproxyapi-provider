// Check 1: the live catalog loads, each family gets its API, and models.dev prices reach the models.
import { fetchCatalog, selectModelApi } from "../../src/core/index.ts";
import type { CliproxyModel } from "../../src/core/index.ts";
import { createCheck, liveConnection, liveModels, saveOutput } from "./live.ts";

const check = createCheck("catalog");
const connection = liveConnection();

const startedAt = Date.now();
const models = await liveModels();
const loadMs = Date.now() - startedAt;

const raw = await fetchCatalog({
  apiKey: connection.apiKey,
  baseUrl: connection.baseUrl,
});

// An independent reading of models.dev: does any provider list this exact id with a price?
const modelsDevResponse = await fetch("https://models.dev/api.json");

// SAFETY: models.dev api.json maps providers to models. This reading uses only optional fields and treats a missing one as no price.
const modelsDev = (await modelsDevResponse.json()) as Record<
  string,
  { models?: Record<string, { cost?: { input?: number; output?: number } }> }
>;

const listedPrice = (id: string): string | undefined => {
  for (const [providerId, provider] of Object.entries(modelsDev)) {
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const bare = modelId.toLowerCase().split("/").at(-1);

      const priced =
        (model.cost?.input ?? 0) > 0 || (model.cost?.output ?? 0) > 0;

      if (priced && bare === id.toLowerCase()) {
        return `${providerId}/${modelId}`;
      }
    }
  }

  return undefined;
};

// SAFETY: Every model in this collection comes from createCliproxyProvider, whose models are CliproxyModel.
const catalog = models.getModels("cliproxyapi") as readonly CliproxyModel[];

const rows = catalog.map((model) => {
  let expectedApi = "openai-responses";

  if (model.id.startsWith("claude-") || model.id.startsWith("kimi-")) {
    expectedApi = "anthropic-messages";
  }

  const pricedOn = listedPrice(model.id);
  const costNonZero = model.cost.input > 0 || model.cost.output > 0;

  check.expect(
    model.api === expectedApi,
    `${model.id} uses ${model.api}, expected ${expectedApi}`
  );
  check.expect(
    model.api === selectModelApi(model.id),
    `${model.id} api differs from selectModelApi`
  );
  check.expect(
    !pricedOn || costNonZero,
    `${model.id} has a models.dev price (${pricedOn}) but zero cost`
  );

  return {
    api: model.api,
    baseUrl: model.baseUrl,
    contextWindow: model.contextWindow,
    cost: model.cost,
    id: model.id,
    maxTokens: model.maxTokens,
    modelsDevEntry: pricedOn ?? null,
    reasoning: model.reasoning,
    supportsFast: model.supportsFast,
    thoughtSummary: model.thoughtSummary,
  };
});

check.expect(catalog.length > 0, "catalog is empty");

check.expect(
  catalog.length ===
    raw.filter((entry) => entry.visibility?.toLowerCase() !== "hide").length,
  `mapped ${catalog.length} models from ${raw.length} catalog entries`
);

const result = check.finish();

await saveOutput("catalog", {
  ...result,
  loadMs,
  modelCount: catalog.length,
  models: rows,
  rawEntryCount: raw.length,
});
