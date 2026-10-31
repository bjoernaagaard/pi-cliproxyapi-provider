import type { JsonRepresentation } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { CliproxyModel } from "../core/index.ts";
import { runWebSearch, selectSearchModel } from "../web-search/index.ts";
import type { WebSearchSource } from "../web-search/index.ts";
import { completeFrom } from "./completions.ts";
import {
  loadCliproxyConfig,
  resolveExtensionConnection,
  saveCliproxyConfig,
} from "./config.ts";

export const WebSearchParameters = Type.Object({
  query: Type.String({
    description: "The web search query keywords or question to look up online",
    minLength: 1,
  }),
});

export const WebSearchOutputSchema = Type.Object({
  query: Type.String({ description: "The trimmed search query" }),
  sources: Type.Array(
    Type.Object({
      title: Type.Optional(Type.String()),
      url: Type.String(),
    }),
    { description: "All unique sources reported by the search response" }
  ),
  text: Type.String({
    description: "Search summary, including any appended source links",
  }),
});

export interface WebSearchOutput {
  query: string;
  sources: WebSearchSource[];
  text: string;
}

export interface WebSearchDetails {
  durationMs?: number;
  model?: string;
  provider?: string;
  query?: string;
  sourcesCount?: number;
}

export interface RegisterWebSearchOptions {
  agentDir: string;
  providerId: string;
  getModels: () => readonly CliproxyModel[];
  /** The catalog without models that are out of quota. Searches pick from these. */
  getAvailableModels: () => readonly CliproxyModel[];
  getStandardCost: (modelId: string) => CliproxyModel["cost"] | undefined;
}

export interface PickSearchModelOptions {
  /** Models to choose from, usually the catalog without out-of-quota models. */
  models: readonly CliproxyModel[];
  getStandardCost: (modelId: string) => CliproxyModel["cost"] | undefined;
  /** The configured searchModel, if any. */
  preferred?: string;
}

/** The model web_search uses: the preferred one when available, else the best ranked. Shared with /cliproxyapi-status. */
export const pickSearchModel = (
  options: PickSearchModelOptions
): CliproxyModel | undefined => {
  const modelId = selectSearchModel(
    options.models.map((model) => ({
      cost: options.getStandardCost(model.id) ?? model.cost,
      id: model.id,
      supportsWebSearch: model.supportsWebSearch,
    })),
    options.preferred
  );

  return options.models.find((candidate) => candidate.id === modelId);
};

/** Arguments that hand the choice back to pickSearchModel. A bare command means the same without a UI. */
const AUTO_ARGUMENTS = new Set(["", "auto", "clear", "current", "reset"]);

const appendSources = (answer: string, sources: WebSearchSource[]): string => {
  if (
    sources.length === 0 ||
    answer.includes("http://") ||
    answer.includes("https://")
  ) {
    return answer;
  }

  const links = sources
    .slice(0, 8)
    .map(
      (source, index) =>
        `${index + 1}. [${source.title || source.url}](${source.url})`
    );

  return `${answer}\n\n## Sources\n${links.join("\n")}`;
};

export const registerWebSearch = (
  pi: ExtensionAPI,
  options: RegisterWebSearchOptions
): void => {
  pi.registerTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Search the web for real-time, current, or online information (such as weather, news, recent events, documentation, or public web data) and return the results.",
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const startedAt = Date.now();
      const query = params.query.trim();

      const connection = resolveExtensionConnection({
        agentDir: options.agentDir,
        env: process.env,
        providerId: options.providerId,
      });

      if (!connection) {
        throw new Error(
          `CLIProxyAPI is not configured. Run /login ${options.providerId}.`
        );
      }

      const model = pickSearchModel({
        getStandardCost: options.getStandardCost,
        models: options.getAvailableModels(),
        preferred: loadCliproxyConfig(options.agentDir).searchModel,
      });

      if (!model) {
        throw new Error(
          "No CLIProxyAPI search model is available. Run /cliproxyapi-refresh."
        );
      }

      const standardCost = options.getStandardCost(model.id);

      const pricedModel = standardCost
        ? { ...model, cost: standardCost }
        : model;

      const details: WebSearchDetails = {
        model: model.id,
        provider: model.provider,
        query,
      };

      const result = await runWebSearch({
        apiKey: connection.apiKey,
        model: pricedModel,
        onProgress: (event) => {
          onUpdate?.({
            content: [{ text: event.message, type: "text" }],
            details,
          });
        },
        query,
        responsesUrl: connection.responsesUrl,
        signal,
      });

      const text = appendSources(result.answer, result.sources);

      const sources = result.sources.map((source) =>
        source.title
          ? { title: source.title, url: source.url }
          : { url: source.url }
      );

      const structuredContent: JsonRepresentation<WebSearchOutput> = {
        query,
        sources,
        text,
      };

      const toolResult = {
        content: [{ text, type: "text" as const }],
        details: {
          ...details,
          durationMs: Date.now() - startedAt,
          sourcesCount: result.sources.length,
        },
        structuredContent,
      };

      if (result.usage) {
        return { ...toolResult, usage: result.usage };
      }

      return toolResult;
    },
    exposure: "direct",
    label: "web_search",
    name: "web_search",
    outputSchema: WebSearchOutputSchema,
    parameters: WebSearchParameters,
    promptGuidelines: [
      "Use the `web_search` tool for any questions that require real-time, current, or online information (e.g., weather, news, recent events, latest releases).",
      "Do NOT attempt to run shell commands (such as bash, PowerShell, curl, wget, python, or scripts) to search the web or check weather/news when `web_search` is available.",
      "Use the returned web search results to formulate your response accurately.",
    ],
    promptSnippet: "Search current and real-time information",
  });

  const searchModelIds = (): string[] =>
    options
      .getModels()
      .filter((model) => model.supportsWebSearch)
      .map((model) => model.id);

  const saveSearchModel = (
    ctx: ExtensionCommandContext,
    searchModel: string | undefined
  ): void => {
    try {
      saveCliproxyConfig(options.agentDir, { searchModel });
    } catch (error) {
      ctx.ui.notify(
        `Failed to save the web search model: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );

      return;
    }

    ctx.ui.notify(
      searchModel
        ? `Web search model set to: ${searchModel}`
        : "Web search will choose a model automatically.",
      "info"
    );
  };

  const pickFromMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    const ids = searchModelIds();

    const automatic = pickSearchModel({
      getStandardCost: options.getStandardCost,
      models: options.getAvailableModels(),
    });

    const autoChoice = `auto (currently ${automatic?.id ?? "none"})`;

    const choice = await ctx.ui.select("Web search model", [
      autoChoice,
      ...ids,
    ]);

    if (choice === undefined) {
      return;
    }

    saveSearchModel(ctx, choice === autoChoice ? undefined : choice);
  };

  pi.registerCommand("websearch-model", {
    description:
      "Set the CLIProxyAPI model used for web_search (/websearch-model [model-id|auto])",
    getArgumentCompletions: (prefix) =>
      completeFrom(["auto", ...searchModelIds()], prefix),
    handler: async (args, ctx) => {
      const requested = args.trim();

      if (!requested && ctx.hasUI) {
        await pickFromMenu(ctx);

        return;
      }

      if (AUTO_ARGUMENTS.has(requested)) {
        saveSearchModel(ctx, undefined);

        return;
      }

      const model = options
        .getModels()
        .find(
          (candidate) => candidate.id.toLowerCase() === requested.toLowerCase()
        );

      if (!model) {
        ctx.ui.notify(
          `Model "${requested}" is not in the CLIProxyAPI catalog.`,
          "warning"
        );

        return;
      }

      saveSearchModel(ctx, model.id);
    },
  });
};
