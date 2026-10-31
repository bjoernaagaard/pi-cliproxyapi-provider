export interface Endpoints {
  rootUrl: string;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  modelsUrl: string;
  messagesUrl: string;
  responsesUrl: string;
  chatCompletionsUrl: string;
}

export interface ConnectionValues {
  baseUrl?: string;
  apiKey?: string;
}

export interface ResolvedConnection extends Endpoints {
  baseUrl: string;
  apiKey: string;
}

/** Where a connection value came from: the environment, cliproxyapi.json, pi's /login, or the built-in default. */
export type ValueSource = "env" | "cliproxyapi.json" | "login" | "default";

export interface ConnectionSources {
  baseUrl: ValueSource;
  /** Undefined when no API key is configured. */
  apiKey?: ValueSource;
}

const HTTP_SCHEME = /^https?:\/\//iu;
const OTHER_SCHEME = /^[a-z][a-z\d+.-]*:\/\//iu;
const TRAILING_SLASHES = /\/+$/u;

const ENDPOINT_SUFFIX =
  /\/(?:v1(?:\/(?:models|messages|responses|chat\/completions))?|backend-api(?:\/codex\/responses)?)$/u;

export const DEFAULT_BASE_URL = "http://127.0.0.1:8317";

export const resolveEndpoints = (baseUrl: string): Endpoints => {
  const input = baseUrl.trim();

  if (!input) {
    throw new Error("baseUrl is empty");
  }

  if (OTHER_SCHEME.test(input) && !HTTP_SCHEME.test(input)) {
    throw new Error("baseUrl must use HTTP or HTTPS");
  }

  const url = new URL(HTTP_SCHEME.test(input) ? input : `http://${input}`);

  if (url.username || url.password) {
    throw new Error("baseUrl must not contain credentials");
  }

  const path = url.pathname
    .replace(TRAILING_SLASHES, "")
    .replace(ENDPOINT_SUFFIX, "");

  const rootUrl = `${url.origin}${path}`;

  return {
    anthropicBaseUrl: rootUrl,
    chatCompletionsUrl: `${rootUrl}/v1/chat/completions`,
    messagesUrl: `${rootUrl}/v1/messages`,
    modelsUrl: `${rootUrl}/v1/models?client_version=cpa`,
    openaiBaseUrl: `${rootUrl}/v1`,
    responsesUrl: `${rootUrl}/v1/responses`,
    rootUrl,
  };
};

const firstSource = (
  candidates: readonly (readonly [ValueSource, string | undefined])[]
): ValueSource | undefined =>
  candidates.find(([, value]) => value?.trim())?.[0];

/** The sources resolveConnection takes its values from, in the same priority order. Never returns the values. */
export const resolveConnectionSources = (
  env: Readonly<Record<string, string | undefined>>,
  file: ConnectionValues = {},
  stored: ConnectionValues = {}
): ConnectionSources => {
  const baseUrl =
    firstSource([
      ["env", env.CLIPROXYAPI_BASE_URL],
      ["cliproxyapi.json", file.baseUrl],
      ["login", stored.baseUrl],
    ]) ?? "default";

  const apiKey = firstSource([
    ["env", env.CLIPROXYAPI_API_KEY],
    ["cliproxyapi.json", file.apiKey],
    ["login", stored.apiKey],
  ]);

  return apiKey ? { apiKey, baseUrl } : { baseUrl };
};

export const resolveConnection = (
  env: Readonly<Record<string, string | undefined>>,
  file: ConnectionValues = {},
  stored: ConnectionValues = {}
): ResolvedConnection | null => {
  const baseUrl =
    [env.CLIPROXYAPI_BASE_URL, file.baseUrl, stored.baseUrl, DEFAULT_BASE_URL]
      .map((value) => value?.trim())
      .find(Boolean) ?? DEFAULT_BASE_URL;

  const apiKey = [env.CLIPROXYAPI_API_KEY, file.apiKey, stored.apiKey]
    .map((value) => value?.trim())
    .find(Boolean);

  if (!apiKey) {
    return null;
  }

  return { apiKey, baseUrl, ...resolveEndpoints(baseUrl) };
};
