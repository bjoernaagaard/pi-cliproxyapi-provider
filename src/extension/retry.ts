import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TRANSIENT_STREAM_ERROR =
  /\bclosed network connection\b|\bstream disconnected before completion: stream closed before response\.completed\b|\binvalid SSE data JSON\b/iu;

export const normalizeTransientNetworkError = (
  message: AssistantMessage
): AssistantMessage => {
  if (
    message.stopReason !== "error" ||
    !message.errorMessage ||
    isRetryableAssistantError(message) ||
    !TRANSIENT_STREAM_ERROR.test(message.errorMessage)
  ) {
    return message;
  }

  return {
    ...message,
    errorMessage: `network error: ${message.errorMessage}`,
  };
};

export const registerTransientNetworkErrorRetry = (
  pi: ExtensionAPI,
  providerId: string
): void => {
  pi.on("message_end", (event) => {
    const { message } = event;

    if (message.role !== "assistant" || message.provider !== providerId) {
      return;
    }

    const normalized = normalizeTransientNetworkError(message);

    return normalized === message ? undefined : { message: normalized };
  });
};
