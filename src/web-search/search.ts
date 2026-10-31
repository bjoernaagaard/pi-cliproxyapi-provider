import { calculateCost } from "@earendil-works/pi-ai";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";

import { resolveResponsesEndpoint } from "./endpoint.ts";
import { consumeSseStream } from "./sse.ts";
import type { SseEvent } from "./sse.ts";

export interface WebSearchSource {
  url: string;
  title?: string;
}

export type WebSearchProgressPhase =
  | "starting"
  | "searching"
  | "analyzing"
  | "generating"
  | "done";

export interface WebSearchProgressEvent {
  type: WebSearchProgressPhase;
  phase: WebSearchProgressPhase;
  message: string;
  model: string;
  query: string;
  searchQuery?: string;
  chars?: number;
  sourcesCount?: number;
  durationMs?: number;
}

export interface RunWebSearchOptions {
  /** CLIProxyAPI root, `/v1` base URL, or full `/v1/responses` URL. */
  responsesUrl: string;
  apiKey?: string;
  /** A model id, or a pi-ai Model when usage cost should be priced. */
  model: string | Model<Api>;
  query: string;
  signal?: AbortSignal;
  onProgress?: (event: WebSearchProgressEvent) => void;
  referenceDate?: Date | string;
  fetchFn?: typeof fetch;
}

export interface WebSearchResult {
  answer: string;
  sources: WebSearchSource[];
  usage?: Usage;
}

interface ResponsesSourcePayload {
  title?: string;
  url?: string;
}

interface ResponsesContentPayload {
  annotations?: ResponsesSourcePayload[];
  text?: string;
  type?: string;
}

interface ResponsesItemPayload {
  action?: {
    query?: string;
    sources?: ResponsesSourcePayload[];
  };
  content?: ResponsesContentPayload[];
  type?: string;
}

interface ResponsesUsagePayload {
  input_tokens?: number;
  input_tokens_details?: {
    cache_write_tokens?: number;
    cached_tokens?: number;
  };
  output_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  total_tokens?: number;
}

interface ResponsesPayload {
  error?: {
    message?: string;
  };
  message?: string;
  output?: ResponsesItemPayload[];
  usage?: ResponsesUsagePayload;
}

interface ResponsesEventPayload extends ResponsesPayload {
  delta?: string;
  error?: {
    message?: string;
  };
  item?: ResponsesItemPayload;
  message?: string;
  response?: ResponsesPayload;
  text?: string;
  type?: string;
}

interface SearchStreamState {
  completedMessageText: string;
  lastDeltaUpdateTime: number;
  lastPhase: string;
  rawUsage?: ResponsesUsagePayload;
  sources: Map<string, string>;
  streamedMessageText: string;
  streamedText: string;
}

type ProgressEmitter = (
  phase: WebSearchProgressPhase,
  message: string,
  extra?: Partial<WebSearchProgressEvent>
) => void;

export const SEARCH_INSTRUCTIONS =
  "You are a web search assistant. Search the web to find accurate, up-to-date information for the user's query. Provide a comprehensive summary with all relevant details, numbers, dates, and sources.";

export const buildSearchInstructions = (
  referenceDate: Date | string = new Date()
): string => {
  const date =
    referenceDate instanceof Date ? referenceDate : new Date(referenceDate);

  const dateStr = Number.isNaN(date.getTime())
    ? String(referenceDate).slice(0, 10)
    : date.toISOString().slice(0, 10);

  return `${SEARCH_INSTRUCTIONS}\nCurrent reference date: ${dateStr}. Use this reference date to ground relative time expressions (such as today, yesterday, recent, latest, or this year) and ensure search queries and results remain up to date.`;
};

const extractErrorMessage = (
  payload: ResponsesEventPayload,
  defaultMessage: string
): string => {
  if (payload.error?.message?.trim()) {
    return payload.error.message.trim();
  }

  if (payload.message?.trim()) {
    return payload.message.trim();
  }

  return defaultMessage;
};

const isTokenCount = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0;

const toUsage = (
  raw: ResponsesUsagePayload | undefined,
  model: Model<Api> | undefined
): Usage | undefined => {
  if (!raw) {
    return undefined;
  }

  const input = raw.input_tokens;
  const output = raw.output_tokens;
  const cacheRead = raw.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = raw.input_tokens_details?.cache_write_tokens ?? 0;
  const reasoning = raw.output_tokens_details?.reasoning_tokens ?? 0;

  const totalTokens =
    raw.total_tokens ??
    (isTokenCount(input) && isTokenCount(output) ? input + output : undefined);

  if (
    !isTokenCount(input) ||
    !isTokenCount(output) ||
    !isTokenCount(cacheRead) ||
    !isTokenCount(cacheWrite) ||
    !isTokenCount(reasoning) ||
    !isTokenCount(totalTokens)
  ) {
    return undefined;
  }

  const usage: Usage = {
    cacheRead,
    cacheWrite,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: Math.max(0, input - cacheRead - cacheWrite),
    output,
    reasoning,
    totalTokens,
  };

  if (model) {
    calculateCost(model, usage);
  }

  return usage;
};

const addSource = (
  sources: Map<string, string>,
  urlValue: string | undefined,
  titleValue: string | undefined
): void => {
  if (!urlValue?.trim()) {
    return;
  }

  const url = urlValue.trim();
  const title = titleValue?.trim() ?? "";

  if (!sources.has(url) || (!sources.get(url) && title)) {
    sources.set(url, title);
  }
};

const extractSourcesFromItem = (
  item: ResponsesItemPayload,
  sources: Map<string, string>
): void => {
  if (item.type === "web_search_call") {
    for (const source of item.action?.sources ?? []) {
      addSource(sources, source.url, source.title);
    }
  }

  if (item.type === "message") {
    for (const part of item.content ?? []) {
      for (const annotation of part.annotations ?? []) {
        addSource(sources, annotation.url, annotation.title);
      }
    }
  }
};

const messageTextFromItem = (item: ResponsesItemPayload): string => {
  if (item.type !== "message") {
    return "";
  }

  const parts: string[] = [];

  for (const part of item.content ?? []) {
    if ((part.type === "output_text" || part.type === "text") && part.text) {
      parts.push(part.text);
    }
  }

  return parts.join("");
};

const lastMessageText = (output: ResponsesItemPayload[]): string => {
  let text = "";

  for (const item of output) {
    const candidate = messageTextFromItem(item);

    if (candidate.trim()) {
      text = candidate;
    }
  }

  return text;
};

const handleLifecycleEvent = (
  eventType: string,
  state: SearchStreamState,
  emit: ProgressEmitter,
  query: string
): boolean => {
  if (
    eventType === "response.web_search_call.searching" ||
    eventType === "response.web_search_call.in_progress"
  ) {
    if (state.lastPhase !== "searching") {
      state.lastPhase = "searching";
      emit("searching", `Searching the web for ${query}...`);
    }

    return true;
  }

  if (eventType === "response.web_search_call.completed") {
    if (state.lastPhase !== "analyzing") {
      state.lastPhase = "analyzing";
      emit("analyzing", "Analyzing search results...");
    }

    return true;
  }

  return false;
};

const handleTextEvent = (
  eventType: string,
  payload: ResponsesEventPayload,
  state: SearchStreamState,
  emit: ProgressEmitter
): boolean => {
  if (eventType === "response.output_text.delta") {
    if (payload.delta) {
      state.streamedText += payload.delta;
      const now = Date.now();

      if (now - state.lastDeltaUpdateTime >= 100) {
        state.lastDeltaUpdateTime = now;
        emit(
          "generating",
          `Summarizing results (${state.streamedText.length} chars)...`,
          {
            chars: state.streamedText.length,
          }
        );
      }
    }

    return true;
  }

  if (eventType === "response.output_text.done") {
    if (payload.text && !state.streamedText) {
      state.streamedText = payload.text;
    }

    return true;
  }

  return false;
};

const handleItemEvent = (
  eventType: string,
  payload: ResponsesEventPayload,
  state: SearchStreamState,
  emit: ProgressEmitter
): boolean => {
  if (
    eventType !== "response.output_item.done" &&
    eventType !== "response.output_item.added"
  ) {
    return false;
  }

  if (!payload.item) {
    return true;
  }

  extractSourcesFromItem(payload.item, state.sources);

  const searchQuery = payload.item.action?.query;

  if (
    payload.item.type === "web_search_call" &&
    searchQuery &&
    state.lastPhase !== "searching"
  ) {
    state.lastPhase = "searching";
    emit("searching", `Searching the web for ${searchQuery}...`, {
      searchQuery,
    });
  }

  const text = messageTextFromItem(payload.item);

  if (text.trim()) {
    state.streamedMessageText = text;
  }

  return true;
};

const handleCompletedEvent = (
  eventType: string,
  payload: ResponsesEventPayload,
  state: SearchStreamState
): boolean => {
  if (eventType !== "response.completed") {
    return false;
  }

  const completed = payload.response ?? payload;
  state.rawUsage = completed.usage;

  for (const item of completed.output ?? []) {
    extractSourcesFromItem(item, state.sources);
  }

  if (completed.output) {
    // Fact 2: Kimi and Muse put the answer in a later message item.
    state.completedMessageText = lastMessageText(completed.output);
  }

  return true;
};

const handleEvent = (
  { event, data }: SseEvent,
  state: SearchStreamState,
  emit: ProgressEmitter,
  query: string
): void => {
  // SAFETY: SSE JSON uses the Responses wire shape. Every payload field is
  // optional in the local payload types and is checked before it is used.
  const payload = data as ResponsesEventPayload;
  const eventType = payload.type ?? event;

  if (eventType === "response.failed" || eventType === "error") {
    throw new Error(extractErrorMessage(payload, "Web search response failed"));
  }

  if (handleLifecycleEvent(eventType, state, emit, query)) {
    return;
  }

  if (handleTextEvent(eventType, payload, state, emit)) {
    return;
  }

  if (handleItemEvent(eventType, payload, state, emit)) {
    return;
  }

  handleCompletedEvent(eventType, payload, state);
};

export const runWebSearch = async (
  options: RunWebSearchOptions
): Promise<WebSearchResult> => {
  const {
    responsesUrl,
    apiKey,
    model,
    query,
    signal,
    onProgress,
    referenceDate = new Date(),
    fetchFn = fetch,
  } = options;

  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    throw new Error("web_search requires a non-empty query");
  }

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The typed union is a model id string or a pi-ai Model, and typeof is the intended way to tell them apart.
  const modelObject = typeof model === "object" ? model : undefined;

  const modelId = modelObject ? modelObject.id : String(model).trim();

  if (!modelId) {
    throw new Error("web_search requires a model");
  }

  signal?.throwIfAborted();

  const startTime = Date.now();

  const emit: ProgressEmitter = (phase, message, extra = {}) => {
    onProgress?.({
      message,
      model: modelId,
      phase,
      query: trimmedQuery,
      type: phase,
      ...extra,
    });
  };

  emit("starting", `Starting web search (${modelId})...`);

  const baseHeaders = {
    accept: "text/event-stream",
    "content-type": "application/json",
  };

  const headers = apiKey
    ? { ...baseHeaders, authorization: `Bearer ${apiKey}` }
    : baseHeaders;

  const response = await fetchFn(resolveResponsesEndpoint(responsesUrl), {
    body: JSON.stringify({
      input: [
        {
          content: [{ text: trimmedQuery, type: "input_text" }],
          role: "user",
        },
      ],
      instructions: buildSearchInstructions(referenceDate),
      model: modelId,
      store: false,
      stream: true,
      tools: [{ type: "web_search" }],
    }),
    headers,
    method: "POST",
    signal,
  });

  if (!response.ok) {
    let errorText = `HTTP ${response.status}`;

    try {
      const parsed: ResponsesEventPayload = JSON.parse(await response.text());
      errorText = extractErrorMessage(parsed, errorText);
    } catch {
      // Keep the HTTP status fallback when the error body is not JSON.
    }

    throw new Error(`Web search failed: ${errorText}`);
  }

  if (!response.body) {
    throw new Error("Web search streaming response has no body");
  }

  const state: SearchStreamState = {
    completedMessageText: "",
    lastDeltaUpdateTime: 0,
    lastPhase: "",
    sources: new Map<string, string>(),
    streamedMessageText: "",
    streamedText: "",
  };

  await consumeSseStream(
    response.body,
    (event) => handleEvent(event, state, emit, trimmedQuery),
    signal
  );
  signal?.throwIfAborted();

  const answer = (
    state.completedMessageText ||
    state.streamedMessageText ||
    state.streamedText
  ).trim();

  if (!answer) {
    throw new Error("Web search completed without any search result text");
  }

  const usage = toUsage(state.rawUsage, modelObject);
  const sourceList: WebSearchSource[] = [];

  for (const [url, title] of state.sources) {
    const source: WebSearchSource = { url };

    if (title) {
      source.title = title;
    }

    sourceList.push(source);
  }

  emit("done", "Web search complete.", {
    durationMs: Date.now() - startTime,
    sourcesCount: sourceList.length,
  });

  const result: WebSearchResult = { answer, sources: sourceList };

  if (usage) {
    result.usage = usage;
  }

  return result;
};
