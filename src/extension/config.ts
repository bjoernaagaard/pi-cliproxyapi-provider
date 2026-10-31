import path from "node:path";

import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { DEFAULT_BASE_URL, resolveConnection } from "../core/index.ts";
import type {
  CliproxyModel,
  ConnectionValues,
  ResolvedConnection,
  ThoughtSummary,
} from "../core/index.ts";
import {
  memoByFile,
  readJsonFile,
  readJsonMemo,
  writeJsonAtomic,
} from "./files.ts";

export const CONFIG_FILE_NAME = "cliproxyapi.json";
export const MODELS_CACHE_FILE_NAME = "cliproxyapi-provider-models.json";
export const DEFAULT_PROVIDER_ID = "cliproxyapi";
export const DEFAULT_PROVIDER_NAME = "CLIProxyAPI";
export const CREDENTIAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export interface CliproxyConfig extends ConnectionValues {
  providerId?: string;
  providerName?: string;
  fast?: boolean;
  pause?: boolean;
  /** CLIProxyAPI management key. Unlocks the usage footer and account-wide hiding. */
  managementKey?: string;
  thinkingDisplay?: Readonly<Record<string, ThoughtSummary>>;
  searchModel?: string;
}

export interface ModelsCache {
  baseUrl: string;
  fast: boolean;
  fastModelIds: string[];
  fetchedAt: number;
  models: CliproxyModel[];
}

export interface ExtensionIdentity {
  providerId: string;
  providerName: string;
}

export interface ResolveExtensionConnectionOptions {
  agentDir: string;
  env: Readonly<Record<string, string | undefined>>;
  providerId: string;
  stored?: ConnectionValues;
}

const firstNonEmpty = (
  ...values: (string | undefined)[]
): string | undefined => {
  for (const value of values) {
    const trimmed = value?.trim();

    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
};

const OptionalString = Type.Optional(Type.String());

const ConfigFileSchema = Type.Object({
  apiKey: OptionalString,
  baseUrl: OptionalString,
  fast: Type.Optional(Type.Boolean()),
  managementKey: OptionalString,
  pause: Type.Optional(Type.Boolean()),
  providerId: OptionalString,
  providerName: OptionalString,
  searchModel: OptionalString,
  thinkingDisplay: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Union([Type.Literal("summarized"), Type.Literal("omitted")])
    )
  ),
});

const RefreshMetaSchema = Type.Object({ baseUrl: OptionalString });

const SettingsFileSchema = Type.Object({
  defaultModel: OptionalString,
  defaultProvider: OptionalString,
});

const ModelsCacheFileSchema = Type.Object({
  baseUrl: Type.String(),
  fast: Type.Boolean(),
  fastModelIds: Type.Array(Type.String()),
  fetchedAt: Type.Optional(Type.Number()),
  models: Type.Array(Type.Unknown()),
});

const nonEmpty = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

/** Read on every request, so it comes from the file memo. The result is a fresh object callers may change. */
export const loadCliproxyConfig = (agentDir: string): CliproxyConfig => {
  const value = readJsonMemo(
    path.join(agentDir, CONFIG_FILE_NAME),
    ConfigFileSchema
  );

  if (!value) {
    return {};
  }

  return {
    apiKey: nonEmpty(value.apiKey),
    baseUrl: nonEmpty(value.baseUrl),
    fast: value.fast,
    managementKey: nonEmpty(value.managementKey),
    pause: value.pause,
    providerId: nonEmpty(value.providerId),
    providerName: nonEmpty(value.providerName),
    searchModel: nonEmpty(value.searchModel),
    thinkingDisplay: { ...value.thinkingDisplay },
  };
};

export const saveCliproxyConfig = (
  agentDir: string,
  update: Partial<CliproxyConfig>
): void => {
  writeJsonAtomic(path.join(agentDir, CONFIG_FILE_NAME), {
    ...loadCliproxyConfig(agentDir),
    ...update,
  });
};

export const resolveIdentity = (
  agentDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): ExtensionIdentity => {
  const config = loadCliproxyConfig(agentDir);

  return {
    providerId:
      firstNonEmpty(
        env.CLIPROXYAPI_PROVIDER_ID,
        config.providerId,
        DEFAULT_PROVIDER_ID
      ) ?? DEFAULT_PROVIDER_ID,
    providerName:
      firstNonEmpty(
        env.CLIPROXYAPI_PROVIDER_NAME,
        config.providerName,
        DEFAULT_PROVIDER_NAME
      ) ?? DEFAULT_PROVIDER_NAME,
  };
};

export const decodeRefreshMeta = (
  refresh: string | undefined
): ConnectionValues => {
  if (!refresh?.trim()) {
    return {};
  }

  try {
    const value: unknown = JSON.parse(refresh);

    return Value.Check(RefreshMetaSchema, value)
      ? { baseUrl: nonEmpty(value.baseUrl) }
      : {};
  } catch {
    return {};
  }
};

export const buildOAuthCredentials = (
  baseUrl: string,
  apiKey: string
): OAuthCredentials => ({
  access: apiKey,
  expires: Date.now() + CREDENTIAL_TTL_MS,
  refresh: JSON.stringify({ baseUrl }),
});

export const loadStoredConnection = (
  agentDir: string,
  providerId: string
): ConnectionValues => {
  try {
    const authPath = path.join(agentDir, "auth.json");

    const credential = memoByFile(
      authPath,
      () => readStoredCredential(providerId, authPath),
      providerId
    );

    if (credential?.type === "oauth" && credential.access.trim()) {
      return {
        apiKey: credential.access.trim(),
        ...decodeRefreshMeta(credential.refresh),
      };
    }

    if (credential?.type === "api_key" && credential.key?.trim()) {
      return { apiKey: credential.key.trim() };
    }
  } catch {
    return {};
  }

  return {};
};

export const resolveExtensionConnection = (
  options: ResolveExtensionConnectionOptions
): ResolvedConnection | null => {
  const stored =
    options.stored ??
    loadStoredConnection(options.agentDir, options.providerId);

  return resolveConnection(
    options.env,
    loadCliproxyConfig(options.agentDir),
    stored
  );
};

export const isModelReferencedAsDefault = (
  agentDir: string,
  providerId: string,
  modelId: string
): boolean => {
  try {
    const settings = readJsonFile(
      path.join(agentDir, "settings.json"),
      SettingsFileSchema
    );

    const defaultModel = nonEmpty(settings?.defaultModel);
    const defaultProvider = nonEmpty(settings?.defaultProvider);

    if (!defaultModel) {
      return false;
    }

    return (
      defaultModel === `${providerId}/${modelId}` ||
      defaultModel === `${providerId}:${modelId}` ||
      (defaultModel === modelId &&
        (!defaultProvider || defaultProvider === providerId))
    );
  } catch {
    return false;
  }
};

export const defaultConnectionBaseUrl = (
  agentDir: string,
  providerId: string,
  env: Readonly<Record<string, string | undefined>> = process.env
): string =>
  firstNonEmpty(
    env.CLIPROXYAPI_BASE_URL,
    loadCliproxyConfig(agentDir).baseUrl,
    loadStoredConnection(agentDir, providerId).baseUrl,
    DEFAULT_BASE_URL
  ) ?? DEFAULT_BASE_URL;

export const loadModelsCache = (
  agentDir: string,
  baseUrl: string,
  fast: boolean
): ModelsCache | undefined => {
  try {
    const value = readJsonFile(
      path.join(agentDir, MODELS_CACHE_FILE_NAME),
      ModelsCacheFileSchema
    );

    if (value?.baseUrl !== baseUrl || value.fast !== fast) {
      return undefined;
    }

    return {
      baseUrl,
      fast,
      fastModelIds: value.fastModelIds.filter((id) => id.trim()),
      fetchedAt: value.fetchedAt ?? 0,
      // SAFETY: This cache is written only from core's CliproxyModel mapping. Invalid JSON shapes are rejected by the provider refresh.
      models: value.models as CliproxyModel[],
    };
  } catch {
    return undefined;
  }
};

export const saveModelsCache = (
  agentDir: string,
  cache: Omit<ModelsCache, "fetchedAt"> & { fetchedAt?: number }
): void => {
  writeJsonAtomic(path.join(agentDir, MODELS_CACHE_FILE_NAME), {
    ...cache,
    fetchedAt: cache.fetchedAt ?? Date.now(),
  });
};
