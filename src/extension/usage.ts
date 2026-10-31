import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

import {
  QUOTA_FALLBACK_MS,
  fetchUsage,
  quotaResetFromError,
  resetCooldowns as resetServerCooldowns,
  unavailableModels,
} from "../core/index.ts";
import type { ProviderUsage } from "../core/index.ts";
import { loadCliproxyConfig, resolveExtensionConnection } from "./config.ts";
import { readJsonMemo, writeJsonAtomic } from "./files.ts";

/** Shared by every pi process, so a quota error in one agent hides the model in all of them. */
export const USAGE_FILE_NAME = "cliproxyapi-usage.json";
export const MANAGEMENT_KEY_ENV = "CLIPROXY_MANAGEMENT_KEY";

/** How old the shared usage snapshot may get before a session fetches a new one. */
const USAGE_TTL_MS = 2 * 60_000;
const STATUS_KEY = "cliproxyapi-usage";
const SAME_DAY_MS = 20 * 60 * 60_000;

const UsageWindowSchema = Type.Object({
  label: Type.String(),
  resetAt: Type.Optional(Type.Number()),
  usedPercent: Type.Number(),
});

const ProviderUsageSchema = Type.Object({
  exhaustedUntil: Type.Optional(Type.Number()),
  models: Type.Array(Type.String()),
  name: Type.String(),
  observedAt: Type.Optional(Type.Number()),
  provider: Type.String(),
  windows: Type.Array(UsageWindowSchema),
});

const UsageFileSchema = Type.Object({
  baseUrl: Type.Optional(Type.String()),
  exhausted: Type.Record(Type.String(), Type.Number()),
  fetchedAt: Type.Optional(Type.Number()),
  providers: Type.Array(ProviderUsageSchema),
  resets: Type.Optional(Type.Record(Type.String(), Type.Number())),
});

type UsageFile = Static<typeof UsageFileSchema>;

const EMPTY: UsageFile = { exhausted: {}, providers: [] };

export type ManagementKeySource = "env" | "cliproxyapi.json";

/** For /cliproxyapi-status. Holds where the key comes from, never the key. */
export interface ManagementStatus {
  source: ManagementKeySource;
  /** When usage was last fetched for the current base URL. */
  usageFetchedAt?: number;
}

export interface UsageTrackerOptions {
  agentDir: string;
  providerId: string;
  env?: Readonly<Record<string, string | undefined>>;
  fetchFn?: typeof fetch;
}

const formatTime = (time: number, now: number): string => {
  const options: Intl.DateTimeFormatOptions =
    time - now < SAME_DAY_MS
      ? { hour: "2-digit", hourCycle: "h23", minute: "2-digit" }
      : {
          hour: "2-digit",
          hourCycle: "h23",
          minute: "2-digit",
          weekday: "short",
        };

  return new Intl.DateTimeFormat(undefined, options).format(time);
};

export class UsageTracker {
  private readonly filePath: string;
  private readonly options: UsageTrackerOptions;
  /** Quota marks this tracker guessed, by model id, until a usage fetch names the real reset. */
  private readonly guessedMarks = new Map<
    string,
    { recordedAt: number; until: number }
  >();

  constructor(options: UsageTrackerOptions) {
    this.options = options;
    this.filePath = path.join(options.agentDir, USAGE_FILE_NAME);
  }

  private connection() {
    return resolveExtensionConnection({
      agentDir: this.options.agentDir,
      env: this.options.env ?? process.env,
      providerId: this.options.providerId,
    });
  }

  private managementKeyWithSource():
    | { key: string; source: ManagementKeySource }
    | undefined {
    const env = this.options.env ?? process.env;
    const fromEnv = env[MANAGEMENT_KEY_ENV]?.trim();

    if (fromEnv) {
      return { key: fromEnv, source: "env" };
    }

    const fromFile = loadCliproxyConfig(this.options.agentDir).managementKey;

    return fromFile ? { key: fromFile, source: "cliproxyapi.json" } : undefined;
  }

  private managementKey(): string | undefined {
    return this.managementKeyWithSource()?.key;
  }

  /**
   * A missing or broken file counts as empty: it only holds a cache. The
   * result is shared through the file memo, so callers build new objects
   * instead of changing it.
   */
  private read(): UsageFile {
    try {
      return readJsonMemo(this.filePath, UsageFileSchema) ?? EMPTY;
    } catch {
      return EMPTY;
    }
  }

  private write(update: (current: UsageFile) => UsageFile): void {
    const now = Date.now();
    const next = update(this.read());

    const exhausted = Object.fromEntries(
      Object.entries(next.exhausted).filter(([, until]) => until > now)
    );

    writeJsonAtomic(this.filePath, { ...next, exhausted });
  }

  /** Accounts from the last usage fetch for the current base URL. */
  private providers(file: UsageFile): ProviderUsage[] {
    return file.baseUrl === this.connection()?.baseUrl ? file.providers : [];
  }

  hasManagementKey(): boolean {
    return this.managementKey() !== undefined;
  }

  /** The management key's source and the usage snapshot's time, or undefined without a key. */
  managementStatus(): ManagementStatus | undefined {
    const managed = this.managementKeyWithSource();

    if (!managed) {
      return undefined;
    }

    const file = this.read();

    const usageFetchedAt =
      file.baseUrl === this.connection()?.baseUrl ? file.fetchedAt : undefined;

    return usageFetchedAt === undefined
      ? { source: managed.source }
      : { source: managed.source, usageFetchedAt };
  }

  /** Base URL and management key for management commands, or undefined when either is unavailable. */
  managementAccess(): { baseUrl: string; managementKey: string } | undefined {
    const managementKey = this.managementKey();
    const connection = this.connection();

    if (!managementKey || !connection) {
      return undefined;
    }

    return { baseUrl: connection.baseUrl, managementKey };
  }

  /**
   * Hidden models from one usage file. A reset clears the server cooldown
   * but not its preserved quota observations, so an observation recorded
   * before the reset must not hide the model again; a local quota-error
   * mark (re)recorded after the reset still does.
   */
  private hiddenFrom(file: UsageFile, now: number): Map<string, number> {
    const resets = file.resets ?? {};

    // Discard each account's stale exhaustion on its own: one account
    // observed after the reset must not let another account's pre-reset
    // exhaustion hide a model the reset account can serve again. Local
    // quota-error marks in file.exhausted are merged separately and still hide.
    return unavailableModels(
      this.providers(file),
      file.exhausted,
      now,
      (account, model) => {
        const resetAt = resets[model];

        return (
          resetAt !== undefined &&
          (account.observedAt ?? file.fetchedAt ?? 0) <= resetAt
        );
      }
    );
  }

  /** Model ids that no account can serve now, each with the time it comes back. */
  hidden(now = Date.now()): Map<string, number> {
    return this.hiddenFrom(this.read(), now);
  }

  filter<T extends { id: string }>(models: readonly T[]): T[] {
    const hidden = this.hidden();

    return models.filter((model) => !hidden.has(model.id));
  }

  /**
   * True when the message was a quota error, which hides the model until its
   * reset. Like CLIProxyAPI, a quota error covers the whole account, so its
   * other models hide too. Claude is the exception: it also has per-model weekly
   * limits, and its account-wide windows come from the usage fetch instead.
   *
   * The mark is written at once, without a network call. When the message
   * names no reset time, as Claude's account rate limit does, the mark is a
   * guess: the reset of the account's full window in the snapshot on disk,
   * else 15 minutes. The next usage fetch replaces the guess with the reset
   * it reports, unless the mark changed in between, such as by a reset.
   */
  recordError(modelId: string, message: string): boolean {
    const now = Date.now();

    const guess =
      this.accountResets(this.read(), now).get(modelId) ??
      now + QUOTA_FALLBACK_MS;

    const until = quotaResetFromError(message, now, guess);

    if (until === undefined) {
      return false;
    }

    const marked: string[] = [];

    this.write((file) => {
      const siblings = this.providers(file)
        .filter(
          (account) =>
            account.provider !== "claude" && account.models.includes(modelId)
        )
        .flatMap((account) => account.models);

      const exhausted = { ...file.exhausted };

      for (const id of [modelId, ...siblings]) {
        if ((exhausted[id] ?? 0) < until) {
          exhausted[id] = until;
          marked.push(id);
        }
      }

      return { ...file, exhausted };
    });

    if (until === guess) {
      for (const id of marked) {
        this.guessedMarks.set(id, { recordedAt: now, until });
      }
    }

    return true;
  }

  /**
   * Each model whose accounts are all full, with the time the first comes
   * back. Local quota marks don't count.
   */
  private accountResets(file: UsageFile, now: number): Map<string, number> {
    return this.hiddenFrom({ ...file, exhausted: {} }, now);
  }

  /**
   * Clears local quota marks from the shared exhausted map: one model, or
   * every model when no id is given. Returns the model ids that were cleared.
   */
  clearExhausted(modelId?: string): string[] {
    const cleared = Object.keys(this.read().exhausted).filter(
      (id) => modelId === undefined || id === modelId
    );

    if (cleared.length === 0) {
      return cleared;
    }

    this.write((file) => ({
      ...file,
      exhausted:
        modelId === undefined
          ? {}
          : Object.fromEntries(
              Object.entries(file.exhausted).filter(([id]) => id !== modelId)
            ),
    }));

    return cleared;
  }

  /**
   * Resets cooldowns on the server and clears the matching local quota
   * marks, so pi stops hiding the models too. Returns the model ids the
   * server reports as affected.
   */
  async resetCooldowns(modelId?: string): Promise<string[]> {
    const managementKey = this.managementKey();
    const connection = this.connection();

    if (!managementKey) {
      throw new Error(
        `No CLIProxyAPI management key is configured. Set ${MANAGEMENT_KEY_ENV} in the environment or "managementKey" in cliproxyapi.json, then try again.`
      );
    }

    if (!connection) {
      throw new Error(
        "CLIProxyAPI is not configured, so its cooldowns cannot be reset."
      );
    }

    const affected = await resetServerCooldowns({
      baseUrl: connection.baseUrl,
      fetch: this.options.fetchFn,
      managementKey,
      modelId,
    });

    if (modelId === undefined) {
      this.clearExhausted();
    } else {
      // A server reset clears the whole credential, so its other models
      // come back too: recordError hid them locally alongside this one.
      for (const id of new Set([modelId, ...affected])) {
        this.clearExhausted(id);
      }
    }

    // The server preserves quota observations across a reset; remember when
    // each model was reset so hiddenFrom can ignore the older observations.
    const resetAt = Date.now();
    const resetIds = modelId === undefined ? affected : [modelId, ...affected];

    if (resetIds.length > 0) {
      this.write((file) => ({
        ...file,
        resets: {
          ...file.resets,
          ...Object.fromEntries(resetIds.map((id) => [id, resetAt])),
        },
      }));
    }

    return affected;
  }

  /** A reply proves the model works again. True when that cleared a quota mark. */
  recordSuccess(modelId: string): boolean {
    if (this.read().exhausted[modelId] === undefined) {
      return false;
    }

    this.write((file) => ({
      ...file,
      exhausted: Object.fromEntries(
        Object.entries(file.exhausted).filter(([id]) => id !== modelId)
      ),
    }));

    return true;
  }

  /** Fetches usage when the shared snapshot is older than its TTL. Needs the management key. */
  async refresh(force = false, signal?: AbortSignal): Promise<void> {
    const managementKey = this.managementKey();
    const connection = this.connection();

    if (!managementKey || !connection) {
      return;
    }

    const current = this.read();

    if (
      !force &&
      current.baseUrl === connection.baseUrl &&
      current.fetchedAt !== undefined &&
      Date.now() - current.fetchedAt < USAGE_TTL_MS
    ) {
      return;
    }

    const startedAt = Date.now();

    const providers = await fetchUsage({
      baseUrl: connection.baseUrl,
      fetch: this.options.fetchFn,
      managementKey,
      signal,
    });

    this.write((file) => {
      const fetchedAt = Date.now();

      const next: UsageFile = {
        ...file,
        baseUrl: connection.baseUrl,
        fetchedAt,
        providers,
      };

      const resets = this.accountResets(next, fetchedAt);
      const exhausted = { ...next.exhausted };

      // A fetch that started before a guess was made can't know its reset.
      for (const [id, guessed] of this.guessedMarks) {
        if (guessed.recordedAt > startedAt) {
          continue;
        }

        this.guessedMarks.delete(id);
        const reset = resets.get(id);

        // A mark that changed since the guess, or was cleared, is not ours to move.
        if (reset !== undefined && exhausted[id] === guessed.until) {
          exhausted[id] = reset;
        }
      }

      return { ...next, exhausted };
    });
  }

  /** When the next hidden model comes back or the snapshot goes stale, whichever is first. */
  nextChangeAt(now = Date.now()): number {
    const returns = [...this.hidden(now).values()];
    const fetchedAt = this.read().fetchedAt ?? now;
    const stale = this.hasManagementKey() ? fetchedAt + USAGE_TTL_MS : Infinity;

    return Math.max(now + 1000, Math.min(stale, ...returns));
  }

  /** One footer line for the accounts behind the given catalog, or undefined when nothing is known. */
  footer(catalogIds: readonly string[], now = Date.now()): string | undefined {
    const file = this.read();
    const hidden = this.hiddenFrom(file, now);
    const catalog = new Set(catalogIds);
    const covered = new Set<string>();
    const parts: string[] = [];

    for (const account of this.providers(file)) {
      const models = account.models.filter((model) => catalog.has(model));

      if (models.length === 0) {
        continue;
      }

      for (const model of models) {
        covered.add(model);
      }

      const returns = models.map((model) => hidden.get(model));

      if (returns.every((time) => time !== undefined)) {
        parts.push(
          `${account.name} out until ${formatTime(Math.min(...returns), now)}`
        );
        continue;
      }

      const windows = account.windows.map(
        (window) => `${Math.round(window.usedPercent)}% ${window.label}`
      );

      parts.push(
        `${account.name} ${windows.length > 0 ? windows.join(", ") : "n/a"}`
      );
    }

    for (const [model, until] of hidden) {
      if (catalog.has(model) && !covered.has(model)) {
        parts.push(`${model} out until ${formatTime(until, now)}`);
      }
    }

    return parts.length > 0 ? parts.join(" │ ") : undefined;
  }
}

export interface RegisterUsageOptions {
  providerId: string;
  tracker: UsageTracker;
  getCatalogIds: () => readonly string[];
}

/**
 * Keeps pi's model list and the usage footer in step with the shared usage
 * file: quota errors hide a model, replies and resets bring it back.
 */
export interface UsageHandle {
  /** Fetches usage now and applies it, for /cliproxyapi-refresh. */
  refresh: (ctx: ExtensionContext) => Promise<void>;
}

export const registerUsage = (
  pi: ExtensionAPI,
  options: RegisterUsageOptions
): UsageHandle => {
  const { providerId, tracker } = options;
  let active: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastHidden = "";
  let notifiedModel: string | undefined;
  let lastWarning: string | undefined;

  const warn = (ctx: ExtensionContext, message: string): void => {
    if (ctx.hasUI && message !== lastWarning) {
      lastWarning = message;
      ctx.ui.notify(message, "warning");
    }
  };

  const noticeCurrentModel = (
    ctx: ExtensionContext,
    hidden: ReadonlyMap<string, number>
  ): void => {
    const current = ctx.model;

    const until =
      current?.provider === providerId ? hidden.get(current.id) : undefined;

    if (until === undefined || !current) {
      notifiedModel = undefined;

      return;
    }

    if (notifiedModel !== current.id) {
      notifiedModel = current.id;
      warn(
        ctx,
        `${current.id} is out of quota until ${formatTime(until, Date.now())}. Pick another model with /model.`
      );
    }
  };

  const sync = async (ctx: ExtensionContext): Promise<void> => {
    const hidden = tracker.hidden();
    const key = [...hidden.keys()].toSorted().join(",");

    if (key !== lastHidden) {
      lastHidden = key;
      // Recomputes pi's available list through filterModels without a network call.
      await ctx.modelRegistry.refresh({
        allowNetwork: false,
        providers: [providerId],
      });
    }

    noticeCurrentModel(ctx, hidden);

    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, tracker.footer(options.getCatalogIds()));
  };

  /** Applies the usage file to pi without a network call. */
  const syncNow = async (ctx: ExtensionContext): Promise<void> => {
    try {
      await sync(ctx);
    } catch (error) {
      warn(
        ctx,
        `CLIProxyAPI model list: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const update = async (
    ctx: ExtensionContext,
    force: boolean
  ): Promise<void> => {
    try {
      await tracker.refresh(force);
    } catch (error) {
      warn(
        ctx,
        `CLIProxyAPI usage: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    await syncNow(ctx);

    if (!ctx.hasUI || !active) {
      return;
    }

    if (timer) {
      clearTimeout(timer);
    }

    // Wakes when a hidden model comes back or the usage snapshot goes stale.
    timer = setTimeout(() => {
      timer = undefined;

      if (active) {
        void update(active, false);
      }
    }, tracker.nextChangeAt() - Date.now());
    timer.unref();
  };

  pi.on("message_end", async (event, ctx) => {
    const { message } = event;

    if (message.role !== "assistant" || message.provider !== providerId) {
      return;
    }

    const quotaError =
      message.stopReason === "error" &&
      tracker.recordError(message.model, message.errorMessage ?? "");

    const changed =
      quotaError ||
      (message.stopReason !== "error" &&
        message.stopReason !== "aborted" &&
        tracker.recordSuccess(message.model));

    if (!changed) {
      return;
    }

    // pi awaits this handler before it retries, so only the local change
    // waits. The usage fetch runs after it and names a guessed reset.
    await syncNow(ctx);
    void update(ctx, quotaError);
  });
  pi.on("session_start", async (_event, ctx) => {
    active = ctx;
    await update(ctx, false);
  });
  pi.on("agent_end", async (_event, ctx) => {
    await update(ctx, false);
  });
  pi.on("model_select", (_event, ctx) => {
    noticeCurrentModel(ctx, tracker.hidden());
  });
  pi.on("session_shutdown", (_event, ctx) => {
    active = undefined;
    lastHidden = "";
    notifiedModel = undefined;

    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }

    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  return { refresh: (ctx) => update(ctx, true) };
};
