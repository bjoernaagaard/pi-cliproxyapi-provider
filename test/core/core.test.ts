/* oxlint-disable eslint/no-await-in-loop -- Requests are serial so each assertion inspects its own captured payload. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { AssistantMessage, StreamOptions } from "@earendil-works/pi-ai";
import { createModels, hasApi } from "@earendil-works/pi-ai/models";

import {
  createCliproxyProvider,
  fetchCatalog,
  fetchCosts,
  mapCatalog,
  matchModelCost,
  mergeCatalog,
  resolveConnection,
  resolveEndpoints,
  selectModelApi,
} from "../../src/core/index.ts";
import type { CatalogModel, ThoughtSummary } from "../../src/core/index.ts";

const fixture: { models: CatalogModel[] } = JSON.parse(
  await readFile(new URL("fixtures/catalog.json", import.meta.url), "utf-8")
);

const pricing = JSON.parse(
  await readFile(new URL("fixtures/costs.json", import.meta.url), "utf-8")
);

const outputDirectory = new URL("output/", import.meta.url);

const startProxy = async () => {
  const requests: {
    url: string;
    body: {
      thinking?: { display?: string };
      service_tier?: string;
      metadata?: { caller?: string; user_id?: string };
      system?: {
        type: string;
        text: string;
        cache_control?: { type: string };
      }[];
    };
    authorization?: string;
    sessionHeaders: Record<string, string>;
  }[] = [];

  let catalog: { models?: CatalogModel[]; data?: CatalogModel[] } = fixture;

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }

    const body = Buffer.concat(chunks).toString();
    const url = request.url ?? "";
    const sessionHeaders: Record<string, string> = {};

    for (const name of ["x-session-affinity", "x-session-id", "session_id"]) {
      const value = request.headersDistinct[name]?.[0];

      if (value !== undefined) {
        sessionHeaders[name] = value;
      }
    }

    requests.push({
      authorization: request.headers.authorization,
      body: body ? JSON.parse(body) : {},
      sessionHeaders,
      url,
    });

    if (url === "/v1/models?client_version=cpa") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(catalog));

      return;
    }

    if (url === "/costs") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(pricing));

      return;
    }

    response.setHeader("Content-Type", "text/event-stream");

    if (url === "/v1/messages?beta=true") {
      const events = [
        {
          message: {
            content: [],
            id: "msg_test",
            model: "claude-haiku-5-5",
            role: "assistant",
            stop_reason: null,
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 1, output_tokens: 0 },
          },
          type: "message_start",
        },
        {
          content_block: { text: "", type: "text" },
          index: 0,
          type: "content_block_start",
        },
        {
          delta: { text: "ok", type: "text_delta" },
          index: 0,
          type: "content_block_delta",
        },
        { index: 0, type: "content_block_stop" },
        {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          type: "message_delta",
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];

      response.end(
        events
          .map(
            (event) =>
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
          )
          .join("")
      );

      return;
    }

    if (url === "/v1/responses") {
      const result = {
        id: "resp_test",
        model: "gpt-6-luna",
        object: "response",
        output: [],
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };

      response.end(
        `event: response.completed\ndata: ${JSON.stringify({ response: result, type: "response.completed" })}\n\n`
      );

      return;
    }

    if (url === "/v1/chat/completions") {
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok", role: "assistant" }, finish_reason: "stop", index: 0 }], id: "chat_test", usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`
      );

      return;
    }

    response.statusCode = 404;
    response.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: listen(0, "127.0.0.1") binds a TCP port, so address() returns AddressInfo.
  const address = server.address() as AddressInfo;
  const root = `http://127.0.0.1:${address.port}`;

  return {
    async close() {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
    requests,
    root,
    setCatalog(value: { models?: CatalogModel[]; data?: CatalogModel[] }) {
      catalog = value;
    },
  };
};

const context = {
  messages: [{ content: "Say ok", role: "user" as const, timestamp: 1 }],
};

// These tests exercise public functions together with a real HTTP server and SDK requests.
test("endpoint forms, injected connection precedence and family routing", () => {
  for (const input of [
    "localhost:8317",
    "http://localhost:8317/",
    "http://localhost:8317/v1",
    "http://localhost:8317/v1/",
    "http://localhost:8317/v1/messages",
    "http://localhost:8317/v1/responses",
    "http://localhost:8317/v1/chat/completions",
  ]) {
    const endpoints = resolveEndpoints(input);
    assert.equal(endpoints.rootUrl, "http://localhost:8317");
    assert.equal(endpoints.anthropicBaseUrl, endpoints.rootUrl);
    assert.equal(endpoints.openaiBaseUrl, "http://localhost:8317/v1");
    assert.equal(
      endpoints.modelsUrl,
      "http://localhost:8317/v1/models?client_version=cpa"
    );
  }

  assert.equal(
    resolveEndpoints("https://proxy.test/gateway/v1/").rootUrl,
    "https://proxy.test/gateway"
  );
  assert.throws(() => resolveEndpoints(""));
  assert.throws(() => resolveEndpoints("ftp://proxy.test"));

  const env = new Proxy(
    {
      CLIPROXYAPI_API_KEY: "env-key",
      CLIPROXYAPI_BASE_URL: "env.test:8317/v1",
    },
    {
      get(target, key) {
        assert.ok(
          key === "CLIPROXYAPI_BASE_URL" || key === "CLIPROXYAPI_API_KEY"
        );

        return target[key];
      },
    }
  );

  const file = { apiKey: "file-key", baseUrl: "file.test" };
  const stored = { apiKey: "stored-key", baseUrl: "stored.test" };
  assert.equal(resolveConnection(env, file, stored)?.apiKey, "env-key");
  assert.equal(
    resolveConnection(env, file, stored)?.rootUrl,
    "http://env.test:8317"
  );
  assert.equal(resolveConnection({}, file, stored)?.apiKey, "file-key");
  assert.equal(resolveConnection({}, {}, stored)?.apiKey, "stored-key");
  assert.equal(
    resolveConnection({ CLIPROXYAPI_API_KEY: "key" })?.rootUrl,
    "http://127.0.0.1:8317"
  );
  assert.equal(resolveConnection({}), null);
  assert.equal(selectModelApi("claude-haiku-5-5"), "anthropic-messages");

  for (const id of ["gpt-6-luna", "grok-4.7-build-fast", "muse-spark-1.3"]) {
    assert.equal(selectModelApi(id), "openai-responses");
  }

  // Kimi fails on Responses (cache retention) and Chat Completions (developer role).
  assert.equal(selectModelApi("kimi-k3.1-pro"), "anthropic-messages");

  assert.equal(
    selectModelApi("gpt-6-luna", {
      "*": "openai-responses",
      "gpt-*": "openai-completions",
    }),
    "openai-completions"
  );
});

test("catalog fixture maps capabilities, prices, Fast variants, aliases and stale retention", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());

  const entries = await fetchCatalog({
    apiKey: "test-key",
    baseUrl: `${proxy.root}/v1/`,
  });

  const costs = await fetchCosts({ url: `${proxy.root}/costs` });

  const mapped = mapCatalog(entries, {
    baseUrl: proxy.root,
    costs,
    fast: () => true,
  });

  assert.deepEqual(
    mapped.models.map((model) => model.id),
    [
      "claude-haiku-5-5",
      "gpt-6-luna",
      "grok-composer-2.5-fast",
      "kimi-k3.1-pro",
    ]
  );
  const [claude, gpt, grok, kimi] = mapped.models;
  assert.equal(claude?.api, "anthropic-messages");
  assert.equal(claude?.baseUrl, proxy.root);
  assert.equal(claude?.thoughtSummary, "omitted");
  assert.equal(claude?.contextWindow, 200_000);
  assert.equal(claude?.maxTokens, 32_000);
  assert.deepEqual(claude?.input, ["image", "text"]);
  assert.deepEqual(claude?.thinkingLevelMap, {
    high: "high",
    low: "low",
    max: null,
    medium: null,
    minimal: null,
    off: "none",
    ultra: null,
    xhigh: null,
  });
  assert.equal(gpt?.baseUrl, `${proxy.root}/v1`);
  assert.equal(gpt?.cost.input, 12);
  assert.deepEqual(gpt?.cost.tiers, [
    {
      cacheRead: 1,
      cacheWrite: 0,
      input: 24,
      inputTokensAbove: 200_000,
      output: 40,
    },
  ]);
  assert.equal(grok?.cost.input, 2);
  assert.equal(kimi?.contextWindow, 128_000);
  assert.equal(kimi?.maxTokens, 16_384);
  assert.deepEqual(mapped.fastModelIds, ["gpt-6-luna"]);
  assert.equal(matchModelCost("unknown-shared", costs).input, 0);
  assert.equal(matchModelCost("anthropic/claude-haiku-5-5", costs).input, 1);
  assert.equal(matchModelCost("gpt-6-luna", costs).input, 3);
  // Resellers list Muse at other prices. The first-party Meta entry must win.
  assert.equal(matchModelCost("muse-spark-1.3", costs).input, 1.25);
  const first = mergeCatalog([], mapped.models, { now: 100, staleTtlMs: 10 });
  const missing = mergeCatalog(first, [], { now: 1000, staleTtlMs: 10 });
  assert.equal(missing.length, 4);
  assert.ok(missing.every((model) => model.stale && model.staleSince === 1000));
  assert.equal(
    mergeCatalog(missing, [], { now: 1009, staleTtlMs: 10 }).length,
    4
  );
  assert.equal(
    mergeCatalog(missing, [], { now: 1010, staleTtlMs: 10 }).length,
    0
  );

  const restored = mergeCatalog(missing, mapped.models, {
    now: 1005,
    staleTtlMs: 10,
  });

  assert.ok(
    restored.every((model) => !model.stale && model.staleSince === undefined)
  );

  proxy.setCatalog(
    JSON.parse('{"data":[{"id":"bad","context_window":"big"}]}')
  );
  await assert.rejects(
    fetchCatalog({ apiKey: "test-key", baseUrl: proxy.root }),
    /Invalid model catalog/u
  );

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    new URL("catalog.json", outputDirectory),
    JSON.stringify(mapped, null, 2)
  );
});

test("real Anthropic stream and streamSimple preserve final payload hooks and caller display", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const entries = fixture.models;

  for (const simple of [false, true]) {
    for (const summary of [undefined, "omitted", "summarized"] as const) {
      const thoughtSummaries: Record<string, ThoughtSummary> = summary
        ? { "claude-haiku-5-5": summary }
        : {};

      const initial = mapCatalog(entries, {
        baseUrl: proxy.root,
        thoughtSummaries,
      }).models;

      const provider = createCliproxyProvider({
        apiKey: "test-key",
        baseUrl: `${proxy.root}/v1`,
        models: initial,
      });

      const models = createModels();
      models.setProvider(provider);
      const model = models.getModel("cliproxyapi", "claude-haiku-5-5");
      assert.ok(model && hasApi(model, "anthropic-messages"));
      let calls = 0;

      const onPayload: NonNullable<StreamOptions["onPayload"]> = async (
        payload
      ) => {
        calls += 1;

        // SAFETY: The real Anthropic SDK produces a thinking object when thinkingEnabled is true.
        const body = payload as {
          thinking: { display?: string };
          metadata?: unknown;
          system?: unknown;
        };

        assert.equal(
          body.thinking.display,
          summary === "summarized" ? "summarized" : undefined
        );
        body.system = [
          {
            cache_control: { type: "ephemeral" },
            text: "cache me",
            type: "text",
          },
        ];
        await Promise.resolve();

        return { ...body, metadata: { user_id: "caller" } };
      };

      const result = simple
        ? await models.completeSimple(model, context, {
            onPayload,
            reasoning: "high",
          })
        : await models.complete(model, context, {
            onPayload,
            thinkingEnabled: true,
          });

      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(calls, 1);
      const request = proxy.requests.at(-1);
      assert.equal(request?.url, "/v1/messages?beta=true");
      assert.deepEqual(request?.body.metadata, { user_id: "caller" });
      assert.deepEqual(request?.body.system, [
        {
          cache_control: { type: "ephemeral" },
          text: "cache me",
          type: "text",
        },
      ]);

      const explicit = await models.complete(model, context, {
        thinkingDisplay: "summarized",
        thinkingEnabled: true,
      });

      assert.equal(explicit.stopReason, "stop", explicit.errorMessage);
      assert.equal(proxy.requests.at(-1)?.body.thinking?.display, "summarized");
    }
  }

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    new URL("anthropic-requests.json", outputDirectory),
    JSON.stringify(proxy.requests, null, 2)
  );
});

test("dynamic provider refresh uses catalog endpoint and Fast hooks chain mutations on both streams", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());

  const provider = createCliproxyProvider({
    apiKey: "test-key",
    baseUrl: proxy.root,
    costsUrl: `${proxy.root}/costs`,
    fast: () => true,
  });

  const models = createModels();
  models.setProvider(provider);
  assert.equal(provider.getModels().length, 0);
  const refresh = await models.refresh();
  assert.equal(refresh.errors.size, 0);
  const gpt = models.getModel("cliproxyapi", "gpt-6-luna");
  assert.ok(gpt);
  assert.equal(gpt.cost.input, 12);

  for (const simple of [false, true]) {
    let calls = 0;

    const onPayload: NonNullable<StreamOptions["onPayload"]> = (payload) => {
      calls += 1;

      // SAFETY: This callback receives the real Responses request body, whose tier is asserted below.
      const body = payload as {
        service_tier?: string;
        metadata?: { caller: string };
      };

      assert.equal(body.service_tier, "priority");
      body.metadata = { caller: "survives" };
    };

    const result: AssistantMessage = simple
      ? await models.completeSimple(gpt, context, { onPayload })
      : await models.complete(gpt, context, { onPayload });

    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(calls, 1);
    assert.equal(proxy.requests.at(-1)?.url, "/v1/responses");
    assert.equal(proxy.requests.at(-1)?.body.service_tier, "priority");
    assert.deepEqual(proxy.requests.at(-1)?.body.metadata, {
      caller: "survives",
    });
  }

  const kimi = models.getModel("cliproxyapi", "kimi-k3.1-pro");
  assert.ok(kimi);
  await models.completeSimple(kimi, context);
  assert.equal(proxy.requests.at(-1)?.url, "/v1/messages?beta=true");
  assert.equal(proxy.requests.at(-1)?.body.service_tier, undefined);
  proxy.setCatalog({ data: [] });
  await models.refresh();
  assert.equal(provider.getModels().length, 4);
  assert.ok(
    provider.getModels().every((model) => "stale" in model && model.stale)
  );

  const completions = createCliproxyProvider({
    apiKey: "test-key",
    baseUrl: proxy.root,
    models: mapCatalog([{ id: "other" }], {
      baseUrl: proxy.root,
      families: { "*": "openai-completions" },
    }).models,
  });

  models.setProvider(completions);
  const other = models.getModel("cliproxyapi", "other");
  assert.ok(other);
  const result = await models.completeSimple(other, context);
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(proxy.requests.at(-1)?.url, "/v1/chat/completions");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    new URL("provider-requests.json", outputDirectory),
    JSON.stringify(proxy.requests, null, 2)
  );
});

// CLIProxyAPI's session affinity keeps a session on one upstream account, so
// the prompt cache that account holds keeps being read. It reads
// X-Session-Affinity or X-Session-ID. Without one it falls back to a hash of
// the first message, which several sessions with the same opening can share.
test("every family sends pi's session id as a CLIProxyAPI session header", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());

  const models = createModels();
  models.setProvider(
    createCliproxyProvider({
      apiKey: "test-key",
      baseUrl: proxy.root,
      models: mapCatalog(fixture.models, { baseUrl: proxy.root }).models,
    })
  );

  const greeting = {
    messages: [{ content: "hi", role: "user" as const, timestamp: 1 }],
  };

  for (const id of ["claude-haiku-5-5", "kimi-k3.1-pro", "gpt-6-luna"]) {
    const model = models.getModel("cliproxyapi", id);
    assert.ok(model, id);
    await models.completeSimple(model, greeting, { sessionId: `pi-${id}` });

    const headers = proxy.requests.at(-1)?.sessionHeaders ?? {};
    assert.ok(
      Object.values(headers).includes(`pi-${id}`),
      `${id} sent ${JSON.stringify(headers)}`
    );
  }
});

test("mapCatalog declares prompt cache lifetimes only for Anthropic Messages models", () => {
  const lifetimes = { long: 3600, short: 300 };

  const lookup = new Map([
    ["claude-haiku-5-5", lifetimes],
    ["gpt-6-luna", lifetimes],
  ]);

  const { models } = mapCatalog(fixture.models, {
    baseUrl: "http://proxy.test",
    promptCache: (id) => lookup.get(id),
  });

  assert.deepEqual(
    models.map((model) => [model.id, model.promptCache]),
    [
      ["claude-haiku-5-5", lifetimes],
      ["gpt-6-luna", undefined],
      ["grok-composer-2.5-fast", undefined],
      ["kimi-k3.1-pro", undefined],
    ]
  );
});
