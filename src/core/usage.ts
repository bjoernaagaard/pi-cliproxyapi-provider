import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import { resolveEndpoints } from "./connection.ts";

/** One rate-limit window of an upstream account, such as Claude's five hours. */
export interface UsageWindow {
  label: string;
  usedPercent: number;
  /** Epoch milliseconds. */
  resetAt?: number;
}

/** Usage of one CLIProxyAPI credential, the upstream account behind some models. */
export interface ProviderUsage {
  /** CLIProxyAPI's provider id, such as `claude` or `kimi-ai`. */
  provider: string;
  /** Short name for a footer. */
  name: string;
  models: string[];
  windows: UsageWindow[];
  /** Epoch milliseconds until which the account can't serve requests. */
  exhaustedUntil?: number;
  /** Epoch milliseconds when the server recorded the quota signals behind these windows, when it reports one. */
  observedAt?: number;
}

export interface UsageFetchOptions {
  baseUrl: string;
  /** The CLIProxyAPI management key, not the client API key. */
  managementKey: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: number;
}

export interface ResetCooldownsOptions extends UsageFetchOptions {
  /** Reset only the credentials that serve this model. Omit to reset every credential. */
  modelId?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const FULL_PERCENT = 100;

/** Wait this long when a quota error names no reset time and nothing else knows it. */
export const QUOTA_FALLBACK_MS = 15 * MINUTE_MS;

const QUOTA_ERROR =
  /quota exhausted|subscription quota|usage[ _]limit|usage window|insufficient_quota|rate limit reached|exceed your account's rate limit/iu;

const RESETS_AT_EPOCH = /"resets_at"\s*:\s*(?<seconds>\d{9,})/u;
const RESETS_AT_ISO = /resets at (?<time>\d{4}-\d{2}-\d{2}T[\d:.]+Z)/iu;
const RESETS_IN_SECONDS = /"resets_in_seconds"\s*:\s*(?<seconds>\d+)/u;
const TRY_AGAIN_MINUTES = /try again in ~?\s*(?<minutes>\d+)\s*min/iu;

/** Parses a number or numeric string. Undefined for anything else, including NaN. */
const finite = (value: string | number | undefined): number | undefined => {
  if (value === undefined || value === "") {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Parses an ISO time to epoch milliseconds. */
const isoTime = (value: string | undefined): number | undefined => {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);

  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * When an error message says an upstream account ran out of quota, returns the
 * epoch milliseconds when it resets. Undefined for every other error. A message
 * that names no reset time resets at `fallbackAt`, such as the reset of the
 * account's full usage window.
 */
export const quotaResetFromError = (
  message: string,
  now = Date.now(),
  fallbackAt = now + QUOTA_FALLBACK_MS
): number | undefined => {
  if (!QUOTA_ERROR.test(message)) {
    return undefined;
  }

  const epoch = finite(RESETS_AT_EPOCH.exec(message)?.groups?.seconds);
  const inSeconds = finite(RESETS_IN_SECONDS.exec(message)?.groups?.seconds);
  const inMinutes = finite(TRY_AGAIN_MINUTES.exec(message)?.groups?.minutes);

  const candidates = [
    epoch === undefined ? undefined : epoch * SECOND_MS,
    isoTime(RESETS_AT_ISO.exec(message)?.groups?.time),
    inSeconds === undefined ? undefined : now + inSeconds * SECOND_MS,
    inMinutes === undefined ? undefined : now + inMinutes * MINUTE_MS,
  ];

  return (
    candidates.find((time) => time !== undefined && time > now) ?? fallbackAt
  );
};

const SignalsSchema = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number()])
);

type Signals = Static<typeof SignalsSchema>;

const CredentialSchema = Type.Object({
  auth_index: Type.String(),
  disabled: Type.Optional(Type.Boolean()),
  name: Type.String(),
  next_retry_after: Type.Optional(Type.String()),
  provider: Type.String(),
  quota: Type.Optional(
    Type.Object({
      observed_at: Type.Optional(Type.String()),
      signals: Type.Optional(SignalsSchema),
    })
  ),
  quota_plugin_id: Type.Optional(Type.String()),
  unavailable: Type.Optional(Type.Boolean()),
});

type Credential = Static<typeof CredentialSchema>;

const CredentialsSchema = Type.Object({
  files: Type.Array(CredentialSchema),
});

const CredentialModelsSchema = Type.Object({
  models: Type.Array(Type.Object({ id: Type.String() })),
});

const CooldownResetSchema = Type.Object({
  auth_index: Type.String(),
  models: Type.Array(Type.String()),
  status: Type.String(),
});

/** CLIProxyAPI relays the upstream body as text. */
const ApiCallSchema = Type.Object({
  body: Type.Optional(Type.String()),
  status_code: Type.Number(),
});

const KimiUsageSchema = Type.Object({
  usages: Type.Record(
    Type.String(),
    Type.Object({
      reset_time: Type.Optional(Type.String()),
      used_ratio: Type.Number(),
    })
  ),
});

type KimiUsage = Static<typeof KimiUsageSchema>;

const XaiBillingSchema = Type.Object({
  config: Type.Object({
    creditUsagePercent: Type.Number(),
    currentPeriod: Type.Optional(
      Type.Object({
        end: Type.Optional(Type.String()),
        start: Type.Optional(Type.String()),
      })
    ),
  }),
});

type XaiBilling = Static<typeof XaiBillingSchema>;

/** Normalized quota a CLIProxyAPI quota plugin returns for one credential. */
const PluginQuotaSchema = Type.Object({
  groups: Type.Optional(
    Type.Array(
      Type.Object({
        buckets: Type.Optional(
          Type.Array(
            Type.Object({
              remainingFraction: Type.Optional(Type.Number()),
              remaining_fraction: Type.Optional(
                Type.Union([Type.Number(), Type.String()])
              ),
              resetTime: Type.Optional(Type.String()),
              reset_time: Type.Optional(Type.String()),
              window: Type.Optional(Type.String()),
            })
          )
        ),
        displayName: Type.Optional(Type.String()),
        display_name: Type.Optional(Type.String()),
      })
    )
  ),
});

type PluginQuota = Static<typeof PluginQuotaSchema>;

const FOOTER_NAMES = new Map([
  ["antigravity", "antigravity"],
  ["claude", "claude"],
  ["codex", "codex"],
  ["devin", "devin"],
  ["gemini", "gemini"],
  ["kimi-ai", "kimi"],
  ["meta", "muse"],
  ["xai", "grok"],
]);

const KIMI_WINDOWS = [
  ["limit_5h", "5h"],
  ["limit_month_total", "mo"],
] as const;

const DEVIN_WINDOWS = [
  ["daily", "1d"],
  ["weekly", "7d"],
] as const;

const XAI_BILLING_URL =
  "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_AI_USAGE_URL = "https://api.kimi.ai/coding/v1/usages";
const KIMI_AI = /kimi-ai|kimi\.ai/iu;

/** CLIProxyAPI swaps this placeholder for the credential's own access token. */
const TOKEN_HEADER = { Authorization: "Bearer $TOKEN$" } as const;

export const windowLabel = (minutes: number): string => {
  const day = 24 * 60;

  if (minutes >= day && minutes % day === 0) {
    return `${minutes / day}d`;
  }

  if (minutes >= 60 && minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }

  return `${Math.round(minutes)}m`;
};

const usageWindow = (
  label: string,
  usedPercent: number,
  resetAt: number | undefined
): UsageWindow => {
  const window: UsageWindow = { label, usedPercent };

  if (resetAt !== undefined) {
    window.resetAt = resetAt;
  }

  return window;
};

/** Header names arrive in any case. */
const signalReader = (signals: Signals) => {
  const byLowerKey = new Map(
    Object.entries(signals).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    number: (key: string): number | undefined =>
      finite(byLowerKey.get(key.toLowerCase())),
    text: (key: string): string | undefined => {
      const value = byLowerKey.get(key.toLowerCase());

      return value === undefined ? undefined : String(value);
    },
  };
};

/** Claude's unified limits, which CLIProxyAPI records from response headers. */
const claudeWindows = (signals: Signals): UsageWindow[] => {
  const read = signalReader(signals);
  const windows: UsageWindow[] = [];

  for (const label of ["5h", "7d"]) {
    const prefix = `Anthropic-Ratelimit-Unified-${label}`;
    const utilization = read.number(`${prefix}-Utilization`);
    const rejected = read.text(`${prefix}-Status`) === "rejected";

    if (utilization === undefined && !rejected) {
      continue;
    }

    const reset = read.number(`${prefix}-Reset`);
    windows.push(
      usageWindow(
        label,
        rejected ? FULL_PERCENT : (utilization ?? 0) * FULL_PERCENT,
        reset === undefined ? undefined : reset * SECOND_MS
      )
    );
  }

  return windows;
};

/** Codex's primary and secondary limits, which CLIProxyAPI records from response headers. */
const codexWindows = (signals: Signals, observedAt: number): UsageWindow[] => {
  const read = signalReader(signals);
  const windows: UsageWindow[] = [];

  for (const slot of ["Primary", "Secondary"]) {
    const prefix = `X-Codex-${slot}`;
    const used = read.number(`${prefix}-Used-Percent`);
    const minutes = read.number(`${prefix}-Window-Minutes`);

    // Plans without a secondary limit report it as a zero-minute window.
    if (used === undefined || minutes === 0) {
      continue;
    }

    const resetAt = read.number(`${prefix}-Reset-At`);
    const resetAfter = read.number(`${prefix}-Reset-After-Seconds`);
    let reset: number | undefined;

    if (resetAt !== undefined) {
      reset = resetAt * SECOND_MS;
    } else if (resetAfter !== undefined) {
      reset = observedAt + resetAfter * SECOND_MS;
    }

    windows.push(
      usageWindow(
        minutes === undefined ? slot.toLowerCase() : windowLabel(minutes),
        used,
        reset
      )
    );
  }

  return windows;
};

/**
 * Devin's daily and weekly limits, which CLIProxyAPI records in quota signals
 * as remaining percents such as `55%`, with RFC 3339 reset times.
 */
const devinWindows = (signals: Signals): UsageWindow[] => {
  const read = signalReader(signals);
  const windows: UsageWindow[] = [];

  for (const [period, label] of DEVIN_WINDOWS) {
    const remainingText = read.text(`${period}_quota_remaining_percent`);

    const remaining =
      remainingText === undefined
        ? undefined
        : finite(remainingText.trim().replace(/%$/u, ""));

    if (remaining === undefined) {
      continue;
    }

    windows.push(
      usageWindow(
        label,
        FULL_PERCENT - remaining,
        isoTime(read.text(`${period}_quota_reset_at`))
      )
    );
  }

  return windows;
};

/** Windows from a quota plugin's normalized groups and buckets. */
const pluginWindows = (body: PluginQuota | undefined): UsageWindow[] => {
  const windows: UsageWindow[] = [];

  for (const group of body?.groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      const fraction = finite(
        bucket.remainingFraction ?? bucket.remaining_fraction
      );

      if (fraction === undefined) {
        continue;
      }

      const usedPercent = Math.min(
        FULL_PERCENT,
        Math.max(0, (1 - fraction) * FULL_PERCENT)
      );

      windows.push(
        usageWindow(
          bucket.window ?? group.displayName ?? group.display_name ?? "quota",
          usedPercent,
          isoTime(bucket.resetTime ?? bucket.reset_time)
        )
      );
    }
  }

  return windows;
};

const kimiWindows = (body: KimiUsage | undefined): UsageWindow[] => {
  const windows: UsageWindow[] = [];

  for (const [key, label] of KIMI_WINDOWS) {
    const usage = body?.usages[key];

    if (usage) {
      windows.push(
        usageWindow(
          label,
          usage.used_ratio * FULL_PERCENT,
          isoTime(usage.reset_time)
        )
      );
    }
  }

  return windows;
};

const xaiWindows = (body: XaiBilling | undefined): UsageWindow[] => {
  if (!body) {
    return [];
  }

  const period = body.config.currentPeriod;
  const start = isoTime(period?.start);
  const end = isoTime(period?.end);

  const minutes =
    start === undefined || end === undefined
      ? undefined
      : (end - start) / MINUTE_MS;

  return [
    usageWindow(
      minutes !== undefined && minutes > 0 ? windowLabel(minutes) : "period",
      body.config.creditUsagePercent,
      end
    ),
  ];
};

/** Latest reset of the windows that are full. Undefined when none is full. */
const fullUntil = (windows: readonly UsageWindow[]): number | undefined => {
  let until: number | undefined;

  for (const window of windows) {
    if (window.usedPercent >= FULL_PERCENT && window.resetAt !== undefined) {
      until = Math.max(until ?? 0, window.resetAt);
    }
  }

  return until;
};

const parseJson = <Schema extends TSchema>(
  schema: Schema,
  text: string
): Static<Schema> | undefined => {
  try {
    const value: unknown = JSON.parse(text);

    return Value.Check(schema, value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export const fetchUsage = async (
  options: UsageFetchOptions
): Promise<ProviderUsage[]> => {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now();
  const managementUrl = `${resolveEndpoints(options.baseUrl).rootUrl}/v8/management`;

  const headers = {
    Authorization: `Bearer ${options.managementKey}`,
    "Content-Type": "application/json",
  };

  const request = async <Schema extends TSchema>(
    route: string,
    schema: Schema,
    init: RequestInit = {}
  ): Promise<Static<Schema>> => {
    const timeout = AbortSignal.timeout(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );

    const response = await fetchFn(`${managementUrl}${route}`, {
      ...init,
      headers,
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    });

    const [routePath] = route.split("?");

    if (!response.ok) {
      throw new Error(
        `CLIProxyAPI management ${routePath} returned HTTP ${response.status}`
      );
    }

    const value = parseJson(schema, await response.text());

    if (value === undefined) {
      throw new Error(
        `CLIProxyAPI management ${routePath} returned an unexpected shape`
      );
    }

    return value;
  };

  const upstream = async <Schema extends TSchema>(
    credential: Credential,
    url: string,
    schema: Schema
  ): Promise<Static<Schema> | undefined> => {
    const result = await request("/requests/api-call", ApiCallSchema, {
      body: JSON.stringify({
        auth_index: credential.auth_index,
        header: TOKEN_HEADER,
        method: "GET",
        url,
      }),
      method: "POST",
    });

    const ok = result.status_code >= 200 && result.status_code < 300;

    return ok && result.body !== undefined
      ? parseJson(schema, result.body)
      : undefined;
  };

  const windowsFor = async (credential: Credential): Promise<UsageWindow[]> => {
    const signals = credential.quota?.signals ?? {};

    if (credential.provider === "claude") {
      return claudeWindows(signals);
    }

    if (credential.provider === "codex") {
      return codexWindows(
        signals,
        isoTime(credential.quota?.observed_at) ?? now
      );
    }

    if (credential.provider === "devin") {
      return devinWindows(signals);
    }

    if (credential.provider === "xai") {
      return xaiWindows(
        await upstream(credential, XAI_BILLING_URL, XaiBillingSchema)
      );
    }

    if (credential.provider.startsWith("kimi")) {
      const url = KIMI_AI.test(`${credential.provider} ${credential.name}`)
        ? KIMI_AI_USAGE_URL
        : KIMI_USAGE_URL;

      return kimiWindows(await upstream(credential, url, KimiUsageSchema));
    }

    // Providers such as antigravity and gemini record no quota signals, so
    // their windows come from a quota plugin when CLIProxyAPI names one for
    // the credential. Without one there is no recorded format to parse.
    if (credential.quota_plugin_id !== undefined) {
      return pluginWindows(
        await request(
          `/plugins/${encodeURIComponent(credential.quota_plugin_id)}/quota`,
          PluginQuotaSchema,
          {
            body: JSON.stringify({ auth_index: credential.auth_index }),
            method: "POST",
          }
        )
      );
    }

    // Meta's quota endpoint reports no usage and returns an API key, so it is never called.
    return [];
  };

  const { files } = await request("/credentials", CredentialsSchema);
  const credentials = files.filter((credential) => !credential.disabled);

  return Promise.all(
    credentials.map(async (credential): Promise<ProviderUsage> => {
      const [modelList, windows] = await Promise.all([
        request(
          `/credentials/models?name=${encodeURIComponent(credential.name)}`,
          CredentialModelsSchema
        ),
        windowsFor(credential).catch((): UsageWindow[] => []),
      ]);

      const retryAt = isoTime(credential.next_retry_after);

      const cooling =
        credential.unavailable === true &&
        retryAt !== undefined &&
        retryAt > now
          ? retryAt
          : undefined;

      const full = fullUntil(windows);

      const account: ProviderUsage = {
        models: modelList.models.map((model) => model.id),
        name: FOOTER_NAMES.get(credential.provider) ?? credential.provider,
        provider: credential.provider,
        windows,
      };

      // Kimi, xAI, and plugin windows were just fetched live, so they are
      // observed now; only signal-derived windows (Claude, Codex, Devin)
      // carry the server's recorded observation time. Branch in the same
      // order as windowsFor: a claude/codex/devin credential that also
      // names a quota plugin still uses its recorded signals.
      const signalsBased =
        credential.provider === "claude" ||
        credential.provider === "codex" ||
        credential.provider === "devin";

      const fetchedLive =
        !signalsBased &&
        (credential.provider === "xai" ||
          credential.provider.startsWith("kimi") ||
          credential.quota_plugin_id !== undefined);

      const observedAt = fetchedLive
        ? now
        : isoTime(credential.quota?.observed_at);

      if (observedAt !== undefined) {
        account.observedAt = observedAt;
      }

      if (cooling !== undefined || full !== undefined) {
        account.exhaustedUntil = Math.max(cooling ?? 0, full ?? 0);
      }

      return account;
    })
  );
};

/**
 * Resets CLIProxyAPI routing cooldowns on the server and returns the model
 * ids the server reports as affected. With a model id, only the credentials
 * that serve that model are reset; without one, every credential is reset.
 * Credential `auth_index` values stay inside this function: callers pass a
 * model id, never an index.
 */
export const resetCooldowns = async (
  options: ResetCooldownsOptions
): Promise<string[]> => {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const modelId = options.modelId?.trim() || undefined;
  const managementUrl = `${resolveEndpoints(options.baseUrl).rootUrl}/v8/management`;

  const headers = {
    Authorization: `Bearer ${options.managementKey}`,
    "Content-Type": "application/json",
  };

  const request = async <Schema extends TSchema>(
    route: string,
    schema: Schema,
    init: RequestInit = {}
  ): Promise<Static<Schema>> => {
    const timeout = AbortSignal.timeout(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );

    const response = await fetchFn(`${managementUrl}${route}`, {
      ...init,
      headers,
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    });

    const [routePath] = route.split("?");

    if (!response.ok) {
      throw new Error(
        `CLIProxyAPI management ${routePath} returned HTTP ${response.status}`
      );
    }

    const value = parseJson(schema, await response.text());

    if (value === undefined) {
      throw new Error(
        `CLIProxyAPI management ${routePath} returned an unexpected shape`
      );
    }

    return value;
  };

  const { files } = await request("/credentials", CredentialsSchema);
  const credentials = files.filter((credential) => !credential.disabled);

  const served = await Promise.all(
    credentials.map(async (credential) => {
      const modelList = await request(
        `/credentials/models?name=${encodeURIComponent(credential.name)}`,
        CredentialModelsSchema
      );

      return {
        credential,
        models: modelList.models.map((model) => model.id),
      };
    })
  );

  const targets =
    modelId === undefined
      ? served
      : served.filter((entry) => entry.models.includes(modelId));

  if (targets.length === 0) {
    return [];
  }

  const results = await Promise.all(
    targets.map(async ({ credential }) => {
      const result = await request(
        "/routing/cooldown/reset",
        CooldownResetSchema,
        {
          body: JSON.stringify({ auth_index: credential.auth_index }),
          method: "POST",
        }
      );

      if (result.status !== "ok") {
        throw new Error(
          `CLIProxyAPI management /routing/cooldown/reset returned status ${result.status}`
        );
      }

      return result.models;
    })
  );

  return [...new Set(results.flat())];
};

/**
 * Models that no account can serve right now, with the time each comes back.
 * A model served by several accounts stays available until all of them run out.
 */
export const unavailableModels = (
  usage: readonly ProviderUsage[],
  exhausted: Readonly<Record<string, number>>,
  now = Date.now(),
  ignoreAccountExhaustion?: (account: ProviderUsage, model: string) => boolean
): Map<string, number> => {
  const hidden = new Map<string, number>();
  const accountsByModel = new Map<string, ProviderUsage[]>();

  for (const account of usage) {
    for (const model of account.models) {
      const accounts = accountsByModel.get(model);

      if (accounts) {
        accounts.push(account);
      } else {
        accountsByModel.set(model, [account]);
      }
    }
  }

  for (const [model, accounts] of accountsByModel) {
    const until = accounts.map((account) =>
      ignoreAccountExhaustion?.(account, model)
        ? 0
        : (account.exhaustedUntil ?? 0)
    );

    if (until.every((time) => time > now)) {
      hidden.set(model, Math.min(...until));
    }
  }

  for (const [model, until] of Object.entries(exhausted)) {
    if (until > now) {
      hidden.set(model, Math.max(hidden.get(model) ?? 0, until));
    }
  }

  return hidden;
};
