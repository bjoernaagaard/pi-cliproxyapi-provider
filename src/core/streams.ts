import type {
  Model,
  Api,
  ProviderStreams,
  StreamOptions,
} from "@earendil-works/pi-ai";

import type { ThoughtSummary } from "./catalog.ts";

export interface PayloadSettings {
  apiKey: string;
  /** Read at request time so /fast changes existing sessions immediately. */
  fast?: () => boolean;
  thoughtSummaries?: Readonly<Record<string, ThoughtSummary>>;
}

interface RequestPayload {
  thinking?: { display?: string };
  service_tier?: string;
}

const applyPayloadSettings = (
  payload: RequestPayload,
  model: Model<Api>,
  options: StreamOptions | undefined,
  settings: PayloadSettings
): void => {
  if (model.api === "anthropic-messages") {
    const { thinking } = payload;

    if (!thinking) {
      return;
    }

    // The SDK inserts summarized itself, so presence in the payload is not caller intent.
    const explicit =
      options && "thinkingDisplay" in options
        ? options.thinkingDisplay
        : undefined;

    const configured =
      settings.thoughtSummaries?.[model.id] ??
      ("thoughtSummary" in model ? model.thoughtSummary : "omitted");

    if (explicit === "summarized" || explicit === "omitted") {
      thinking.display = explicit;
    } else if (configured === "summarized") {
      thinking.display = configured;
    } else {
      delete thinking.display;
    }
  }

  if (
    model.api === "openai-responses" &&
    (settings.fast?.() ?? false) &&
    "supportsFast" in model &&
    model.supportsFast
  ) {
    payload.service_tier = "priority";
  }
};

/** Run provider edits first; the caller always sees and can replace the final payload. */
export const wrapCliproxyStreams = (
  streams: ProviderStreams,
  settings: PayloadSettings
): ProviderStreams => {
  const withPayload = <T extends StreamOptions>(
    options: T
  ): T & StreamOptions => ({
    ...options,
    apiKey: options?.apiKey ?? settings.apiKey,
    onPayload: async (payload, model) => {
      // SAFETY: These wrappers receive request objects from pi-ai's three SDK adapters, not external JSON.
      applyPayloadSettings(payload as RequestPayload, model, options, settings);

      return (await options?.onPayload?.(payload, model)) ?? payload;
    },
  });

  return {
    ...streams,
    stream: (model, context, options) =>
      streams.stream(model, context, withPayload(options ?? {})),
    streamSimple: (model, context, options) =>
      streams.streamSimple(model, context, withPayload(options ?? {})),
  };
};
