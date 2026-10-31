import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  resolveConnectionSources,
  resolveEndpoints,
  withoutStale,
} from "../core/index.ts";
import type { CliproxyModel } from "../core/index.ts";
import { completeFrom } from "./completions.ts";
import {
  defaultConnectionBaseUrl,
  isModelReferencedAsDefault,
  loadCliproxyConfig,
  loadStoredConnection,
  resolveExtensionConnection,
  resolveIdentity,
} from "./config.ts";
import { FastModeController, toggleFastMode } from "./fast.ts";
import { FastFooterController } from "./footer.ts";
import { registerOAuthLogin } from "./oauth.ts";
import { PauseController, registerPause } from "./pause.ts";
import { PriceCache } from "./prices.ts";
import { createExtensionProvider } from "./provider.ts";
import type { ExtensionProviderController } from "./provider.ts";
import { registerTransientNetworkErrorRetry } from "./retry.ts";
import { registerStatus } from "./status.ts";
import type { StatusSnapshot } from "./status.ts";
import { registerTpsFooter } from "./tps.ts";
import { MANAGEMENT_KEY_ENV, registerUsage, UsageTracker } from "./usage.ts";
import type { UsageHandle } from "./usage.ts";
import { pickSearchModel, registerWebSearch } from "./web-search.ts";

const refreshRegistry = async (
  ctx: ExtensionContext,
  providerId: string
): Promise<void> => {
  const result = await ctx.modelRegistry.refresh({
    force: true,
    providers: [providerId],
  });

  const error = result.errors.get(providerId);

  if (error) {
    throw error;
  }
};

const registerCatalogCommands = (
  pi: ExtensionAPI,
  agentDir: string,
  providerId: string,
  fast: FastModeController,
  controller: ExtensionProviderController,
  footer: FastFooterController,
  usage: UsageHandle
): void => {
  let fastChangePending = false;
  pi.registerCommand("fast", {
    description: "Toggle CLIProxyAPI Fast mode globally.",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /fast", "error");

        return;
      }

      if (fastChangePending) {
        ctx.ui.notify("Fast mode refresh is already running.", "warning");

        return;
      }

      fastChangePending = true;

      try {
        const enabled = await toggleFastMode({
          agentDir,
          fast,
          notify: (message, level) => ctx.ui.notify(message, level),
          refresh: () => refreshRegistry(ctx, providerId),
        });

        if (enabled === undefined) {
          footer.refresh(ctx);

          return;
        }

        const current = ctx.model;

        if (current?.provider === providerId) {
          const refreshed = ctx.modelRegistry
            .getAll()
            .find(
              (model) =>
                model.provider === providerId && model.id === current.id
            );

          if (
            refreshed &&
            JSON.stringify(refreshed.cost) !== JSON.stringify(current.cost) &&
            !(await pi.setModel(refreshed))
          ) {
            throw new Error(`Unable to activate refreshed model ${current.id}`);
          }

          if (enabled && !fast.isModelSupported(current.id)) {
            ctx.ui.notify(
              "Fast mode is enabled, but the current model does not support it.",
              "warning"
            );
          }
        }

        footer.refresh(ctx);
      } catch (error) {
        ctx.ui.notify(
          `Failed to update Fast mode: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      } finally {
        fastChangePending = false;
      }
    },
  });

  pi.registerCommand("cliproxyapi-refresh", {
    description: "Force refresh CLIProxyAPI models from the remote catalog.",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /cliproxyapi-refresh", "error");

        return;
      }

      try {
        await refreshRegistry(ctx, providerId);
        await usage.refresh(ctx);
        const models = controller.getModels();
        const stale = models.filter((model) => model.stale).length;
        ctx.ui.notify(
          `Refreshed ${models.length - stale} CLIProxyAPI models${stale ? `. Hid ${stale} that CLIProxyAPI no longer lists` : ""}.`,
          "info"
        );
      } catch (error) {
        ctx.ui.notify(
          `Failed to refresh CLIProxyAPI models: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
    },
  });
};

const OFFLINE_FLAG = /^(?:1|true|yes)$/iu;

export default async function cliproxyapiProvider(
  pi: ExtensionAPI
): Promise<void> {
  const agentDir = getAgentDir();
  const config = loadCliproxyConfig(agentDir);
  const { providerId, providerName } = resolveIdentity(agentDir);
  const fast = new FastModeController(config.fast ?? false);
  const pause = new PauseController(config.pause ?? false);

  const connection = resolveExtensionConnection({
    agentDir,
    env: process.env,
    providerId,
  });

  const defaultBaseUrl = defaultConnectionBaseUrl(agentDir, providerId);

  const initialConnection =
    connection ??
    ({
      ...resolveEndpoints(defaultBaseUrl),
      apiKey: "login-required",
      baseUrl: defaultBaseUrl,
    } as const);

  let activeContext: ExtensionContext | undefined;
  let latestModels: readonly CliproxyModel[] = [];
  let notifiedStaleModel: string | undefined;
  // A price failure warns once per session, in the UI only. A warning before session_start waits for it.
  let priceWarned = false;
  let pendingPriceWarning: string | undefined;

  const showPriceWarning = (ctx: ExtensionContext): void => {
    if (priceWarned || !pendingPriceWarning || !ctx.hasUI) {
      return;
    }

    priceWarned = true;
    ctx.ui.notify(pendingPriceWarning, "warning");
    pendingPriceWarning = undefined;
  };

  const notifyStaleModel = (ctx: ExtensionContext): void => {
    const stale = latestModels.find(
      (model) =>
        model.stale &&
        ((ctx.model?.provider === providerId && ctx.model.id === model.id) ||
          isModelReferencedAsDefault(agentDir, providerId, model.id))
    );

    if (!stale) {
      notifiedStaleModel = undefined;

      return;
    }

    if (notifiedStaleModel !== stale.id) {
      notifiedStaleModel = stale.id;
      ctx.ui.notify(
        `Model '${stale.id}' is temporarily unavailable upstream. Retaining its cached entry.`,
        "warning"
      );
    }
  };

  const tracker = new UsageTracker({ agentDir, providerId });
  const prices = new PriceCache({ agentDir });

  const controller = createExtensionProvider({
    agentDir,
    config,
    configured: connection !== null,
    connection: initialConnection,
    fast,
    filterAvailable: (models) => tracker.filter(withoutStale(models)),
    onModels: (models) => {
      latestModels = models;

      if (activeContext) {
        notifyStaleModel(activeContext);
      }
    },
    onPriceWarning: (message) => {
      if (priceWarned) {
        return;
      }

      pendingPriceWarning = message;

      if (activeContext) {
        showPriceWarning(activeContext);
      }
    },
    prices,
    providerId,
    providerName,
  });

  // Print and JSON runs never refresh the catalog, so a cold start must load it before pi resolves --model.
  if (
    connection &&
    controller.getModels().length === 0 &&
    !OFFLINE_FLAG.test(process.env.PI_OFFLINE ?? "")
  ) {
    try {
      await controller.refresh(connection);
    } catch (error) {
      // Startup has no UI yet, so stderr is the only place this warning can go.
      console.warn(
        `[cliproxyapi] Failed to load models: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  latestModels = controller.getModels();
  pi.registerProvider(controller.provider);

  const footer = new FastFooterController(providerId, fast, pause);
  footer.register(pi);
  registerPause(pi, agentDir, pause);
  registerTpsFooter(pi, pause, providerId);
  registerTransientNetworkErrorRetry(pi, providerId);

  const usage = registerUsage(pi, {
    getCatalogIds: () => controller.getModels().map((model) => model.id),
    providerId,
    tracker,
  });

  pi.registerCommand("cliproxyapi-reset", {
    description:
      "Reset CLIProxyAPI cooldowns, optionally for one model: /cliproxyapi-reset [model-id].",
    getArgumentCompletions: (prefix) =>
      completeFrom(
        controller.getModels().map((model) => model.id),
        prefix
      ),
    handler: async (args, ctx) => {
      const modelId = args.trim();

      if (/\s/u.test(modelId)) {
        ctx.ui.notify("Usage: /cliproxyapi-reset [model-id]", "error");

        return;
      }

      if (!tracker.hasManagementKey()) {
        ctx.ui.notify(
          `Cannot reset CLIProxyAPI cooldowns: no management key is configured. Set ${MANAGEMENT_KEY_ENV} in the environment or "managementKey" in cliproxyapi.json, then try again.`,
          "error"
        );

        return;
      }

      let affected: string[];

      try {
        affected = await tracker.resetCooldowns(modelId || undefined);
      } catch (error) {
        ctx.ui.notify(
          `Failed to reset CLIProxyAPI cooldowns: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );

        return;
      }

      try {
        await usage.refresh(ctx);
        await refreshRegistry(ctx, providerId);
      } catch (error) {
        ctx.ui.notify(
          `CLIProxyAPI cooldowns were reset, but refreshing models failed: ${error instanceof Error ? error.message : String(error)}`,
          "warning"
        );
      }

      if (modelId && affected.length === 0) {
        ctx.ui.notify(
          `No CLIProxyAPI credential serves ${modelId}; nothing was reset for it.`,
          "warning"
        );

        return;
      }

      ctx.ui.notify(
        affected.length > 0
          ? `Reset CLIProxyAPI cooldowns for: ${affected.join(", ")}.`
          : "Reset CLIProxyAPI cooldowns for all credentials.",
        "info"
      );
    },
  });

  registerCatalogCommands(
    pi,
    agentDir,
    providerId,
    fast,
    controller,
    footer,
    usage
  );
  registerOAuthLogin(pi, {
    providerId,
    refresh: async (ctx) => {
      await refreshRegistry(ctx, providerId);
      await usage.refresh(ctx);
    },
    tracker,
  });
  registerWebSearch(pi, {
    agentDir,
    getAvailableModels: () =>
      tracker.filter(withoutStale(controller.getModels())),
    getModels: () => withoutStale(controller.getModels()),
    getStandardCost: controller.getStandardCost,
    providerId,
  });

  // Reads the files again on each call, so the status shows edits made by other pi processes.
  const gatherStatus = (): StatusSnapshot => {
    const now = Date.now();
    const current = loadCliproxyConfig(agentDir);
    const models = controller.getModels();
    const catalogFetchedAt = controller.getCatalogFetchedAt();
    const priceInfo = prices.describe();
    const management = tracker.managementStatus();

    const sources = resolveConnectionSources(
      process.env,
      current,
      loadStoredConnection(agentDir, providerId)
    );

    const searchModel = pickSearchModel({
      getStandardCost: controller.getStandardCost,
      models: tracker.filter(models),
      preferred: current.searchModel,
    });

    const ageSince = (time: number): number => Math.max(0, now - time);

    return {
      baseUrl: defaultConnectionBaseUrl(agentDir, providerId),
      catalogAgeMs:
        catalogFetchedAt > 0 ? ageSince(catalogFetchedAt) : undefined,
      fast: fast.isEnabled(),
      fastModels: models.filter((model) => model.supportsFast).length,
      keySource: sources.apiKey,
      management: management && {
        source: management.source,
        usageAgeMs:
          management.usageFetchedAt === undefined
            ? undefined
            : ageSince(management.usageFetchedAt),
      },
      models: models.length,
      paused: current.pause ?? pause.isEnabled(),
      prices:
        priceInfo?.fetchedAt === undefined
          ? undefined
          : { ageMs: ageSince(priceInfo.fetchedAt), etag: priceInfo.etag },
      searchModel: {
        configured: current.searchModel,
        effective: searchModel?.id,
      },
      stale: models.filter((model) => model.stale).length,
      thinking: current.thinkingDisplay ?? {},
    };
  };

  registerStatus(pi, gatherStatus);

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    notifyStaleModel(ctx);
    showPriceWarning(ctx);

    const currentConnection = resolveExtensionConnection({
      agentDir,
      env: process.env,
      providerId,
    });

    if (!currentConnection) {
      return;
    }

    // Not forced, so a catalog fetched under 10 minutes ago is reused without a request.
    try {
      const result = await ctx.modelRegistry.refresh({
        providers: [providerId],
      });

      const failure = result.errors.get(providerId);

      if (failure) {
        throw failure;
      }
    } catch (error) {
      ctx.ui.notify(
        `Failed to refresh CLIProxyAPI models: ${error instanceof Error ? error.message : String(error)}`,
        "warning"
      );
    }
  });
  pi.on("model_select", (_event, ctx) => {
    activeContext = ctx;
    notifyStaleModel(ctx);
  });
  pi.on("session_shutdown", () => {
    activeContext = undefined;
    latestModels = [];
    notifiedStaleModel = undefined;
    priceWarned = false;
    pendingPriceWarning = undefined;
  });
}
