import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { Model } from "@earendil-works/pi-ai";

import {
  resolveResponsesEndpoint,
  runWebSearch,
  selectSearchModel,
} from "../../src/web-search/index.ts";
import type { WebSearchProgressEvent } from "../../src/web-search/index.ts";

interface CapturedRequest {
  init?: RequestInit;
  url?: string;
}

interface CapturedBody {
  instructions?: string;
  model?: string;
  stream?: boolean;
  tools?: unknown;
}

interface CapturedHeaders {
  authorization?: string;
}

const fixtureUrl = (name: string) =>
  new URL(`fixtures/${name}`, import.meta.url);

const fixtureText = (name: string): Promise<string> =>
  readFile(fixtureUrl(name), "utf-8");

const streamFromChunks = (chunks: Uint8Array[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });

const splitBytes = (text: string, size: number): Uint8Array[] => {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];

  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.slice(offset, offset + size));
  }

  return chunks;
};

const fetchReturning = (
  body: ReadableStream<Uint8Array>,
  captured?: CapturedRequest
): typeof fetch => {
  const fetchStub = (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    if (captured) {
      captured.url = String(input);
      captured.init = init;
    }

    return Promise.resolve(
      new Response(body, {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      })
    );
  };

  // SAFETY: The stub implements the single fetch call runWebSearch makes and
  // returns a real Response, so treating it as typeof fetch is sound here.
  return fetchStub as typeof fetch;
};

// SAFETY: The fixture supplies the Model fields runWebSearch reads, namely id
// and cost rates, with the exact pi-ai field shapes.
const searchModel = {
  api: "openai-responses",
  baseUrl: "https://proxy.example/v1",
  contextWindow: 128_000,
  cost: { cacheRead: 0.3, cacheWrite: 3.75, input: 3, output: 15 },
  id: "gpt-test",
  input: ["text"],
  maxTokens: 8192,
  name: "GPT Test",
  provider: "cliproxyapi",
  reasoning: false,
} as Model<"openai-responses">;

test("answer comes from the last message item, not the first", async () => {
  const text = await fixtureText("later-message.sse");
  const captured: CapturedRequest = {};
  const progress: WebSearchProgressEvent[] = [];

  const result = await runWebSearch({
    apiKey: "test-key",
    fetchFn: fetchReturning(streamFromChunks(splitBytes(text, 4096)), captured),
    model: "kimi-test",
    onProgress: (event) => progress.push(event),
    query: "  latest pi release  ",
    referenceDate: new Date("2026-10-24T00:00:00.000Z"),
    responsesUrl: "https://proxy.example",
  });

  assert.equal(result.answer, "Final answer from the later item.");
  assert.deepEqual(result.sources, [
    { title: "Example Report", url: "https://example.com/report" },
    { title: "Final Source", url: "https://example.com/final" },
  ]);
  assert.equal(captured.url, "https://proxy.example/v1/responses");

  const body: CapturedBody = JSON.parse(String(captured.init?.body));
  assert.equal(body.model, "kimi-test");
  assert.equal(body.stream, true);
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
  assert.match(String(body.instructions), /2026-10-24/u);

  // SAFETY: runWebSearch sets plain string headers, so reading the
  // authorization field through this narrow shape is sound here.
  const headers = captured.init?.headers as CapturedHeaders;
  assert.equal(headers.authorization, "Bearer test-key");
  assert.ok(progress.some((event) => event.phase === "starting"));
  assert.ok(progress.some((event) => event.phase === "searching"));
  assert.ok(progress.some((event) => event.phase === "done"));
});

test("stream split across chunk boundaries still parses", async () => {
  const text = await fixtureText("later-message.sse");

  const result = await runWebSearch({
    fetchFn: fetchReturning(streamFromChunks(splitBytes(text, 7))),
    model: "claude-test",
    query: "latest pi release",
    responsesUrl: "https://proxy.example/v1",
  });

  assert.equal(result.answer, "Final answer from the later item.");
  assert.equal(result.sources.length, 2);
});

test("error event rejects with the server message", async () => {
  const text = await fixtureText("error.sse");

  await assert.rejects(
    runWebSearch({
      fetchFn: fetchReturning(streamFromChunks(splitBytes(text, 64))),
      model: "gpt-test",
      query: "boom",
      responsesUrl: "https://proxy.example/v1",
    }),
    /Search backend exploded/u
  );
});

test("abort during streaming rejects", async () => {
  const controller = new AbortController();

  const body = new ReadableStream<Uint8Array>({
    start: (streamController) => {
      streamController.enqueue(
        new TextEncoder().encode(
          'event: response.web_search_call.searching\ndata: {"type":"response.web_search_call.searching"}\n\n'
        )
      );
    },
  });

  const promise = runWebSearch({
    fetchFn: fetchReturning(body),
    model: "gpt-test",
    onProgress: (event) => {
      if (event.phase === "searching") {
        controller.abort();
      }
    },
    query: "slow search",
    responsesUrl: "https://proxy.example/v1",
    signal: controller.signal,
  });

  await assert.rejects(promise, /abort/iu);
});

test("usage is pi-ai shaped and cost is computed for a pi-ai Model", async () => {
  const text = await fixtureText("later-message.sse");

  const result = await runWebSearch({
    fetchFn: fetchReturning(streamFromChunks(splitBytes(text, 4096))),
    model: searchModel,
    query: "latest pi release",
    responsesUrl: "https://proxy.example/v1/responses",
  });

  assert.ok(result.usage);
  assert.equal(result.usage.input, 800);
  assert.equal(result.usage.output, 500);
  assert.equal(result.usage.cacheRead, 200);
  assert.equal(result.usage.cacheWrite, 0);
  assert.equal(result.usage.reasoning, 100);
  assert.equal(result.usage.totalTokens, 1500);

  const expectedTotal = (3 * 800 + 15 * 500 + 0.3 * 200) / 1_000_000;
  assert.ok(Math.abs(result.usage.cost.total - expectedTotal) < 1e-12);
  assert.ok(Math.abs(result.usage.cost.input - (3 * 800) / 1_000_000) < 1e-12);
  assert.ok(
    Math.abs(result.usage.cost.output - (15 * 500) / 1_000_000) < 1e-12
  );
});

test("resolveResponsesEndpoint only reaches the v1 responses path", () => {
  assert.equal(
    resolveResponsesEndpoint("https://proxy.example"),
    "https://proxy.example/v1/responses"
  );
  assert.equal(
    resolveResponsesEndpoint("https://proxy.example/"),
    "https://proxy.example/v1/responses"
  );
  assert.equal(
    resolveResponsesEndpoint("https://proxy.example/v1"),
    "https://proxy.example/v1/responses"
  );
  assert.equal(
    resolveResponsesEndpoint("https://proxy.example/v1/responses"),
    "https://proxy.example/v1/responses"
  );
  assert.equal(
    resolveResponsesEndpoint("https://proxy.example/backend-api/codex"),
    "https://proxy.example/backend-api/codex/v1/responses"
  );
  assert.equal(
    resolveResponsesEndpoint("https://proxy.example/backend-api"),
    "https://proxy.example/backend-api/v1/responses"
  );
});

const ids = (...modelIds: string[]) => modelIds.map((id) => ({ id }));
const priced = (id: string, input: number) => ({ cost: { input }, id });

test("selectSearchModel prefers the preferred id, then fast GPT, then Claude Haiku", () => {
  assert.equal(
    selectSearchModel(
      ids("claude-haiku-4-5", "gpt-5-fast"),
      "claude-haiku-4-5"
    ),
    "claude-haiku-4-5"
  );
  assert.equal(
    selectSearchModel(ids("claude-haiku-4-5", "gpt-5-fast")),
    "gpt-5-fast"
  );
  assert.equal(
    selectSearchModel(ids("gpt-6-luna", "claude-haiku-4-5")),
    "gpt-6-luna"
  );
  assert.equal(
    selectSearchModel(ids("kimi-k3", "claude-haiku-4-5")),
    "claude-haiku-4-5"
  );
  assert.equal(
    selectSearchModel(ids("kimi-k3", "claude-sonnet-5")),
    "claude-sonnet-5"
  );
  assert.equal(selectSearchModel([], "gpt-5-fast"), undefined);
  assert.equal(
    selectSearchModel(ids("GPT-5-FAST"), "gpt-5-fast"),
    "GPT-5-FAST"
  );
});

// The live catalog lists gpt-6.1-sol first. Luna answered the same benchmark
// as accurately, faster, and at 1/25 of the cost (test-output/web-search-bench.json).
test("selectSearchModel picks the cheapest priced model within a family group", () => {
  assert.equal(
    selectSearchModel([
      priced("gpt-6.1-sol", 4),
      priced("gpt-6-astra", 20),
      priced("gpt-6-luna", 0.2),
      priced("claude-haiku-5-5", 0.1),
    ]),
    "gpt-6-luna"
  );
  // Zero cost means unknown pricing, so it must not win over a priced model.
  assert.equal(
    selectSearchModel([priced("gpt-unpriced", 0), priced("gpt-6-luna", 0.2)]),
    "gpt-6-luna"
  );
  // Equal or unknown prices keep catalog order.
  assert.equal(
    selectSearchModel([priced("gpt-a", 1), priced("gpt-b", 1)]),
    "gpt-a"
  );
  assert.equal(selectSearchModel(ids("gpt-a", "gpt-b")), "gpt-a");
});
