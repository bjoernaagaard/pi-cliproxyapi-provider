/**
 * Resolve the Responses endpoint from a CLIProxyAPI root, a `/v1` base URL,
 * or a full Responses URL.
 */
export const resolveResponsesEndpoint = (baseUrl: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/u, "");

  if (!normalized) {
    throw new Error("Responses base URL is empty");
  }

  if (normalized.endsWith("/v1/responses")) {
    return normalized;
  }

  if (normalized.endsWith("/v1")) {
    return `${normalized}/responses`;
  }

  return `${normalized}/v1/responses`;
};
