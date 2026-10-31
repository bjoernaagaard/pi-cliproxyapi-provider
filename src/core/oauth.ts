/* oxlint-disable eslint/no-await-in-loop -- OAuth status polling is intentionally sequential so each check sees the latest server state. */
import { setTimeout as delay } from "node:timers/promises";

import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import { resolveEndpoints } from "./connection.ts";

/** Shared options for the CLIProxyAPI v8 management OAuth flow. */
export interface OAuthRequestOptions {
  baseUrl: string;
  /** The CLIProxyAPI management key, not the client API key. */
  managementKey: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export interface StartOAuthOptions extends OAuthRequestOptions {
  /**
   * CLIProxyAPI provider id: `claude`, `codex`, `antigravity`, `kimi`,
   * `kimi-ai`, `xai`, `devin`, `meta`, or a registered plugin provider id.
   * Any other non-empty id is passed through for the server to judge.
   */
  provider: string;
}

/** A started login: open `url`, then poll or cancel with `state`. */
export interface OAuthStart {
  state: string;
  url: string;
  /** `device` for device-code logins (Kimi, xAI, Meta): no callback URL comes back, so poll the status directly. */
  flow?: string;
  /** The code to enter at `url` during a device login, when the server sends one. */
  userCode?: string;
}

export interface SubmitOAuthCallbackOptions extends OAuthRequestOptions {
  provider?: string;
  /** The complete callback URL the browser landed on, with its code and state. */
  redirectUrl?: string;
  state?: string;
  code?: string;
  error?: string;
}

export interface PollOAuthStatusOptions extends OAuthRequestOptions {
  state: string;
  /** Delay between status checks while the login is pending. */
  pollIntervalMs?: number;
  /** Longest total wait before the pending login counts as failed. */
  maxWaitMs?: number;
}

export type OAuthStatusValue = "error" | "ok" | "wait";

export interface OAuthStatus {
  status: OAuthStatusValue;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;

const StartSchema = Type.Object({
  flow: Type.Optional(Type.String()),
  state: Type.String(),
  status: Type.Optional(Type.String()),
  url: Type.String(),
  user_code: Type.Optional(Type.String()),
});

const StatusSchema = Type.Object({
  error: Type.Optional(Type.String()),
  status: Type.Union([
    Type.Literal("error"),
    Type.Literal("ok"),
    Type.Literal("wait"),
  ]),
});

const ErrorSchema = Type.Object({
  error: Type.Optional(Type.String()),
});

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

const nonEmpty = (value: string | undefined, name: string): string => {
  const trimmed = value?.trim() ?? "";

  if (!trimmed) {
    throw new Error(`${name} is empty`);
  }

  return trimmed;
};

const managementUrl = (baseUrl: string): string =>
  `${resolveEndpoints(baseUrl).rootUrl}/v8/management`;

const request = async <Schema extends TSchema>(
  options: OAuthRequestOptions,
  route: string,
  schema: Schema,
  init: RequestInit = {}
): Promise<Static<Schema>> => {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const managementKey = nonEmpty(options.managementKey, "managementKey");
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const response = await fetchFn(`${managementUrl(options.baseUrl)}${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${managementKey}`,
      "Content-Type": "application/json",
    },
    signal: options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout,
  });

  const [routePath] = route.split("?");
  const text = await response.text();

  if (!response.ok) {
    const detail = parseJson(ErrorSchema, text)?.error;

    throw new Error(
      `CLIProxyAPI management ${routePath} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`
    );
  }

  const value = parseJson(schema, text);

  if (value === undefined) {
    throw new Error(
      `CLIProxyAPI management ${routePath} returned an unexpected shape`
    );
  }

  return value;
};

interface OAuthCallbackBody {
  provider?: string;
  redirect_url?: string;
  state?: string;
  code?: string;
  error?: string;
}

/**
 * Starts an upstream account login. The server answers
 * `{ status, url, state }`: `url` is the authorization URL to open and
 * `state` identifies the pending session for the callback, status, and
 * cancellation calls.
 */
export const startOAuth = async (
  options: StartOAuthOptions
): Promise<OAuthStart> => {
  const provider = nonEmpty(options.provider, "provider");

  const result = await request(
    options,
    `/oauth/auth-url?provider=${encodeURIComponent(provider)}`,
    StartSchema
  );

  const start: OAuthStart = { state: result.state, url: result.url };

  if (result.flow) {
    start.flow = result.flow;
  }

  if (result.user_code) {
    start.userCode = result.user_code;
  }

  return start;
};

/**
 * Submits the callback for a started login, either as the complete
 * `redirect_url` the browser landed on or as a bare `state` plus `code`.
 * Acceptance only hands the values to the pending session; poll the status
 * to learn whether the credential exchange finished.
 */
export const submitOAuthCallback = async (
  options: SubmitOAuthCallbackOptions
): Promise<OAuthStatus> => {
  const body: OAuthCallbackBody = {};

  if (options.provider?.trim()) {
    body.provider = options.provider.trim();
  }

  if (options.redirectUrl?.trim()) {
    body.redirect_url = options.redirectUrl.trim();
  } else {
    const state = nonEmpty(options.state, "state");
    const code = options.code?.trim() ?? "";
    const error = options.error?.trim() ?? "";

    if (!code && !error) {
      throw new Error(
        "submitOAuthCallback requires a redirectUrl, or a state with a code or error"
      );
    }

    body.state = state;

    if (code) {
      body.code = code;
    }

    if (error) {
      body.error = error;
    }
  }

  return await request(options, "/oauth/callback", StatusSchema, {
    body: JSON.stringify(body),
    method: "POST",
  });
};

/**
 * Polls a started login until the server reports `ok` or `error`; `wait`
 * means the login is still pending. A wait past `maxWaitMs` comes back as
 * an `error` status, and aborting `signal` rejects instead.
 */
export const pollOAuthStatus = async (
  options: PollOAuthStatusOptions
): Promise<OAuthStatus> => {
  const state = nonEmpty(options.state, "state");
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);

  while (true) {
    options.signal?.throwIfAborted();

    const result = await request(
      options,
      `/oauth/status?state=${encodeURIComponent(state)}`,
      StatusSchema
    );

    if (result.status !== "wait") {
      return result;
    }

    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      return {
        error: "Timed out waiting for the CLIProxyAPI OAuth login to complete.",
        status: "error",
      };
    }

    await delay(Math.min(interval, remaining), undefined, {
      signal: options.signal,
    });
  }
};
