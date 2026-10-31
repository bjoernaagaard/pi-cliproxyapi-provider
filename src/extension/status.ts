import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ThoughtSummary, ValueSource } from "../core/index.ts";
import { MANAGEMENT_KEY_ENV } from "./usage.ts";
import type { ManagementKeySource } from "./usage.ts";

/** Everything /cliproxyapi-status shows. It holds where keys come from, never the keys. */
export interface StatusSnapshot {
  baseUrl: string;
  /** Undefined when no API key is configured. */
  keySource?: ValueSource;
  models: number;
  stale: number;
  /** Undefined when the catalog was never fetched. */
  catalogAgeMs?: number;
  /** Undefined before prices were first loaded. */
  prices?: { ageMs: number; etag?: string };
  fast: boolean;
  fastModels: number;
  paused: boolean;
  /** Undefined without a management key. */
  management?: { source: ManagementKeySource; usageAgeMs?: number };
  searchModel: { configured?: string; effective?: string };
  thinking: Readonly<Record<string, ThoughtSummary>>;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const ETAG_PREFIX_LENGTH = 8;
const ETAG_WRAPPING = /^(?:W\/)?"?|"$/gu;

const KEY_SOURCE_LABELS: Readonly<Record<ValueSource, string>> = {
  "cliproxyapi.json": "key from cliproxyapi.json",
  default: "not configured",
  env: "key from env CLIPROXYAPI_API_KEY",
  login: "key from auth.json (/login)",
};

const MANAGEMENT_SOURCE_LABELS: Readonly<Record<ManagementKeySource, string>> =
  {
    "cliproxyapi.json": "key set (cliproxyapi.json)",
    env: `key set (env ${MANAGEMENT_KEY_ENV})`,
  };

const THINKING_ORDER: readonly ThoughtSummary[] = ["summarized", "omitted"];

/** "just now", "4 min old", "3 h old", "2 d old". */
const formatShortAge = (ageMs: number): string => {
  if (ageMs < MINUTE_MS) {
    return "just now";
  }

  if (ageMs < HOUR_MS) {
    return `${Math.floor(ageMs / MINUTE_MS)} min old`;
  }

  if (ageMs < 2 * DAY_MS) {
    return `${Math.floor(ageMs / HOUR_MS)} h old`;
  }

  return `${Math.floor(ageMs / DAY_MS)} d old`;
};

const formatModels = (snapshot: StatusSnapshot): string => {
  const stale = snapshot.stale > 0 ? ` (${snapshot.stale} stale)` : "";

  const catalog =
    snapshot.catalogAgeMs === undefined
      ? "not fetched"
      : formatShortAge(snapshot.catalogAgeMs);

  return `${snapshot.models}${stale}, catalog ${catalog}`;
};

const formatPrices = (prices: StatusSnapshot["prices"]): string => {
  if (!prices) {
    return "not loaded";
  }

  const etag = prices.etag
    ?.replaceAll(ETAG_WRAPPING, "")
    .slice(0, ETAG_PREFIX_LENGTH);

  return `models.dev, ${formatShortAge(prices.ageMs)}${etag ? ` (etag ${etag})` : ""}`;
};

const formatFast = (snapshot: StatusSnapshot): string => {
  const support =
    snapshot.fastModels === 1
      ? "1 model supports it"
      : `${snapshot.fastModels} models support it`;

  return `${snapshot.fast ? "on" : "off"} (${support})`;
};

const formatManagement = (management: StatusSnapshot["management"]): string => {
  if (!management) {
    return "not set";
  }

  const usage =
    management.usageAgeMs === undefined
      ? ""
      : `, usage ${formatShortAge(management.usageAgeMs)}`;

  return `${MANAGEMENT_SOURCE_LABELS[management.source]}${usage}`;
};

const formatSearchModel = (
  searchModel: StatusSnapshot["searchModel"]
): string =>
  searchModel.configured ??
  `auto (${searchModel.effective ?? "none available"})`;

const formatThinking = (thinking: StatusSnapshot["thinking"]): string => {
  const groups = THINKING_ORDER.flatMap((value) => {
    const ids = Object.keys(thinking)
      .filter((id) => thinking[id] === value)
      .toSorted();

    return ids.length > 0 ? [`${value}: ${ids.join(", ")}`] : [];
  });

  return groups.length > 0 ? groups.join("; ") : "omitted for all models";
};

/** The seven-line block /cliproxyapi-status shows. */
export const formatStatus = (snapshot: StatusSnapshot): string =>
  [
    `CLIProxyAPI  ${snapshot.baseUrl}  ${snapshot.keySource ? KEY_SOURCE_LABELS[snapshot.keySource] : "not configured"}`,
    `Models       ${formatModels(snapshot)}`,
    `Prices       ${formatPrices(snapshot.prices)}`,
    `Fast         ${formatFast(snapshot)}    Paused  ${snapshot.paused ? "yes" : "no"}`,
    `Management   ${formatManagement(snapshot.management)}`,
    `Web search   ${formatSearchModel(snapshot.searchModel)}`,
    `Thinking     ${formatThinking(snapshot.thinking)}`,
  ].join("\n");

export const registerStatus = (
  pi: ExtensionAPI,
  gather: () => StatusSnapshot
): void => {
  pi.registerCommand("cliproxyapi-status", {
    description:
      "Show the CLIProxyAPI connection, models, prices, Fast, pause, usage, web search model, and thought summaries.",
    handler: (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /cliproxyapi-status", "error");

        return Promise.resolve();
      }

      try {
        ctx.ui.notify(formatStatus(gather()), "info");
      } catch (error) {
        ctx.ui.notify(
          `Failed to read CLIProxyAPI status: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }

      return Promise.resolve();
    },
  });
};
