import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";

import type { StreamOptions } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { format } from "oxfmt";

import {
  QUOTA_FALLBACK_MS,
  matchModelCost,
  resolveConnectionSources,
} from "../../src/core/index.ts";
import type { CatalogModel } from "../../src/core/index.ts";
import { completeFrom } from "../../src/extension/completions.ts";
import {
  loadCliproxyConfig,
  loadStoredConnection,
  resolveExtensionConnection,
  saveCliproxyConfig,
} from "../../src/extension/config.ts";
import {
  FastModeController,
  toggleFastMode,
} from "../../src/extension/fast.ts";
import { PriceCache } from "../../src/extension/prices.ts";
import { createExtensionProvider } from "../../src/extension/provider.ts";
import { formatStatus } from "../../src/extension/status.ts";
import { formatTpsSummary } from "../../src/extension/tps.ts";
import { UsageTracker } from "../../src/extension/usage.ts";

const outputDirectory = new URL("output/", import.meta.url);

const catalog: CatalogModel[] = [
  {
    context_window: 200_000,
    id: "claude-haiku-5-5",
    input_modalities: ["text"],
    max_output_tokens: 32_000,
    service_tiers: ["priority"],
    supported_reasoning_levels: ["low", "high"],
  },
  {
    context_window: 128_000,
    id: "gpt-6-luna",
    input_modalities: ["text"],
    max_output_tokens: 16_384,
    service_tiers: ["priority"],
  },
];

const costs = {
  test: {
    models: {
      "claude-haiku-5-5": {
        cost: { input: 1, output: 5 },
      },
      "gpt-6-luna": {
        cost: { input: 2, output: 10 },
        experimental: {
          modes: { fast: { cost: { input: 4, output: 20 } } },
        },
      },
    },
  },
};

const COSTS_ETAG = '"costs-v1"';

/** Set `status` to make /costs fail with it, as models.dev does when it is down. */
interface CostsOutage {
  status?: number;
}

interface CapturedRequest {
  authorization?: string;
  ifNoneMatch?: string;
  body: {
    metadata?: { caller?: string };
    service_tier?: string;
    thinking?: { display?: string };
  };
  url: string;
}

const startProxy = async () => {
  const requests: CapturedRequest[] = [];
  const costsOutage: CostsOutage = {};

  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }

    const rawBody = Buffer.concat(chunks).toString();
    requests.push({
      authorization: request.headers.authorization,
      body: rawBody ? JSON.parse(rawBody) : {},
      ifNoneMatch: request.headers["if-none-match"],
      url: request.url ?? "",
    });

    if (request.url === "/v1/models?client_version=cpa") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ models: catalog }));

      return;
    }

    if (request.url === "/costs" && costsOutage.status) {
      response.statusCode = costsOutage.status;
      response.end();

      return;
    }

    if (request.url === "/costs") {
      response.setHeader("ETag", COSTS_ETAG);

      if (request.headers["if-none-match"] === COSTS_ETAG) {
        response.statusCode = 304;
        response.end();

        return;
      }

      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(costs));

      return;
    }

    response.setHeader("Content-Type", "text/event-stream");

    if (request.url === "/v1/messages?beta=true") {
      const events = [
        {
          message: {
            content: [],
            id: "msg_extension",
            model: "claude-haiku-5-5",
            role: "assistant",
            stop_reason: null,
            stop_sequence: null,
            type: "message_start",
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

    if (request.url === "/v1/responses") {
      const completed = {
        id: "resp_extension",
        model: "gpt-6-luna",
        object: "response",
        output: [],
        status: "completed",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };

      response.end(
        `event: response.completed\ndata: ${JSON.stringify({ response: completed, type: "response.completed" })}\n\n`
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

  return {
    async close() {
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
    },
    costRequests: () => requests.filter((request) => request.url === "/costs"),
    costsOutage,
    requests,
    root: `http://127.0.0.1:${address.port}`,
  };
};

const catalogIds = ["claude-haiku-5-5", "gpt-6-luna"];
const DAY_MS = 24 * 60 * 60 * 1000;

/** A price cache in an empty agent dir, served by a fresh proxy, with a clock the test moves. */
const startPriceCache = async (
  name: string,
  register: (cleanup: () => Promise<void>) => void
) => {
  const proxy = await startProxy();
  register(() => proxy.close());
  const agentDir = new URL(`${name}/`, outputDirectory);
  await rm(agentDir, { force: true, recursive: true });
  const clock = { now: Date.parse("2026-10-29T12:00:00Z") };

  const prices = new PriceCache({
    agentDir: agentDir.pathname,
    costsUrl: `${proxy.root}/costs`,
    now: () => clock.now,
  });

  return {
    agentDir,
    clock,
    prices,
    pricesFile: new URL("cliproxyapi-prices.json", agentDir),
    proxy,
  };
};

const expectPriorityThenTag: NonNullable<StreamOptions["onPayload"]> = (
  payload
) => {
  // SAFETY: The real Responses adapter supplies this request object, and the test asserts its tier before extending it.
  const body = payload as { service_tier?: string; metadata?: unknown };
  assert.equal(body.service_tier, "priority");

  return { ...body, metadata: { caller: "final-hook" } };
};

test("extension connection honors CLIPROXYAPI priority and ignores OPENAI", async () => {
  const agentDir = new URL("connection-agent/", outputDirectory);
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    new URL("cliproxyapi.json", agentDir),
    `${JSON.stringify({ apiKey: "file-key", baseUrl: "file.test" }, null, 2)}\n`
  );

  const env = new Proxy(
    {
      CLIPROXYAPI_API_KEY: "env-key",
      CLIPROXYAPI_BASE_URL: "env.test/v1",
      OPENAI_API_KEY: "must-not-win",
      OPENAI_BASE_URL: "must-not-win.test",
    },
    {
      get(target, key) {
        assert.ok(
          key === "CLIPROXYAPI_API_KEY" || key === "CLIPROXYAPI_BASE_URL"
        );

        // SAFETY: The assertion above restricts property reads to the two injected CLIProxyAPI keys.
        return target[key as keyof typeof target];
      },
    }
  );

  const connection = resolveExtensionConnection({
    agentDir: agentDir.pathname,
    env,
    providerId: "cliproxyapi",
    stored: { apiKey: "stored-key", baseUrl: "stored.test" },
  });

  assert.equal(connection?.apiKey, "env-key");
  assert.equal(connection?.rootUrl, "http://env.test");

  const openAiOnly = resolveExtensionConnection({
    agentDir: agentDir.pathname,
    env: { OPENAI_API_KEY: "ignored", OPENAI_BASE_URL: "ignored.test" },
    providerId: "cliproxyapi",
    stored: {},
  });

  assert.equal(openAiOnly?.apiKey, "file-key");
  assert.equal(openAiOnly?.rootUrl, "http://file.test");

  await writeFile(
    new URL("cliproxyapi.json", agentDir),
    `${JSON.stringify({ thinkingDisplay: { "claude-opus-5-5": "full" } }, null, 2)}\n`
  );
  assert.throws(
    () => loadCliproxyConfig(agentDir.pathname),
    /Invalid cliproxyapi\.json at \/thinkingDisplay\/claude-opus-5-5/u
  );
});

test("saving cliproxyapi.json round-trips and leaves no temp file behind", async () => {
  const agentDir = new URL("save-agent/", outputDirectory);
  await rm(agentDir, { force: true, recursive: true });

  saveCliproxyConfig(agentDir.pathname, { baseUrl: "saved.test", pause: true });
  saveCliproxyConfig(agentDir.pathname, { searchModel: "gpt-6-luna" });

  const saved = loadCliproxyConfig(agentDir.pathname);
  assert.equal(saved.baseUrl, "saved.test");
  assert.equal(saved.pause, true);
  assert.equal(saved.searchModel, "gpt-6-luna");
  assert.deepEqual(await readdir(agentDir), ["cliproxyapi.json"]);
});

test("a save that cannot serialize keeps the old cliproxyapi.json", async () => {
  const agentDir = new URL("failed-save-agent/", outputDirectory);
  await rm(agentDir, { force: true, recursive: true });
  saveCliproxyConfig(agentDir.pathname, { baseUrl: "kept.test" });
  const before = await readFile(new URL("cliproxyapi.json", agentDir), "utf-8");

  // A BigInt cannot become JSON, so this save fails while serializing.
  const unserializable = { baseUrl: "lost.test", count: 1n };

  assert.throws(
    () => saveCliproxyConfig(agentDir.pathname, unserializable),
    TypeError
  );

  assert.equal(
    await readFile(new URL("cliproxyapi.json", agentDir), "utf-8"),
    before
  );
  assert.deepEqual(await readdir(agentDir), ["cliproxyapi.json"]);
});

test("cliproxyapi.json reads see a write from another pi process", async () => {
  const agentDir = new URL("memo-config-agent/", outputDirectory);
  await rm(agentDir, { force: true, recursive: true });
  saveCliproxyConfig(agentDir.pathname, { baseUrl: "memo.test", pause: false });

  assert.deepEqual(
    loadCliproxyConfig(agentDir.pathname),
    loadCliproxyConfig(agentDir.pathname)
  );

  // Another pi process rewrites the file in place with /pause.
  await writeFile(
    new URL("cliproxyapi.json", agentDir),
    `${JSON.stringify({ baseUrl: "memo.test", pause: true }, null, 2)}\n`
  );

  assert.equal(loadCliproxyConfig(agentDir.pathname).pause, true);
});

test("a quota mark written by one usage tracker hides the model in another", async () => {
  const agentDir = new URL("memo-usage-agent/", outputDirectory);
  await rm(agentDir, { force: true, recursive: true });
  await mkdir(agentDir, { recursive: true });

  const options = {
    agentDir: agentDir.pathname,
    env: {},
    providerId: "cliproxyapi",
  };

  const reader = new UsageTracker(options);
  const writer = new UsageTracker(options);

  assert.equal(reader.hidden().has("gpt-6-luna"), false);
  assert.equal(
    await writer.recordError(
      "gpt-6-luna",
      "usage_limit reached, try again in 30 minutes"
    ),
    true
  );
  assert.equal(reader.hidden().has("gpt-6-luna"), true);
});

/** What pi recorded when a Claude subscription ran out on 2026-10-31. */
const CLAUDE_ACCOUNT_RATE_LIMIT =
  '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}';

/** The Claude account's 5h window resets 40 minutes from now, as it did on 2026-10-31. */
const CLAUDE_5H_RESET_SECONDS = Math.floor(Date.now() / 1000) + 40 * 60;

/** Management requests with this key wait until the test releases them. */
const HELD_KEY = "held-management-key";

/**
 * A CLIProxyAPI management API with one Claude account whose 5h window is
 * full. The server recorded that before any test request, and keeps the
 * observation across cooldown resets, as CLIProxyAPI does.
 */
const startManagement = async () => {
  const observedAt = new Date().toISOString();

  const gate = new EventTarget();
  let released = false;

  const release = () => {
    released = true;
    gate.dispatchEvent(new Event("release"));
  };

  const server = createServer(async (request, response) => {
    if (request.headers.authorization === `Bearer ${HELD_KEY}` && !released) {
      await once(gate, "release");
    }

    response.setHeader("Content-Type", "application/json");

    if (request.url === "/v8/management/credentials") {
      response.end(
        JSON.stringify({
          files: [
            {
              auth_index: "0",
              name: "claude-account.json",
              provider: "claude",
              quota: {
                observed_at: observedAt,
                signals: {
                  "Anthropic-Ratelimit-Unified-5h-Reset": String(
                    CLAUDE_5H_RESET_SECONDS
                  ),
                  "Anthropic-Ratelimit-Unified-5h-Status": "rejected",
                },
              },
            },
          ],
        })
      );

      return;
    }

    if (
      request.url ===
      "/v8/management/credentials/models?name=claude-account.json"
    ) {
      response.end(JSON.stringify({ models: [{ id: "claude-opus-5-5" }] }));

      return;
    }

    if (request.url === "/v8/management/routing/cooldown/reset") {
      response.end(
        JSON.stringify({
          auth_index: "0",
          models: ["claude-opus-5-5"],
          status: "ok",
        })
      );

      return;
    }

    response.statusCode = 404;
    response.end();
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // SAFETY: listen(0, "127.0.0.1") binds a TCP port, so address() returns AddressInfo.
  const { port } = server.address() as AddressInfo;

  return {
    close: () => {
      release();
      server.closeAllConnections();
      server.close();
    },
    release,
    root: `http://127.0.0.1:${port}`,
  };
};

const usageAgentDir = async (name: string): Promise<URL> => {
  const agentDir = new URL(`${name}/`, outputDirectory);
  await rm(agentDir, { force: true, recursive: true });
  await mkdir(agentDir, { recursive: true });

  return agentDir;
};

const managedTracker = (agentDir: URL, root: string, managementKey: string) =>
  new UsageTracker({
    agentDir: agentDir.pathname,
    env: {
      CLIPROXYAPI_API_KEY: "usage-test-key",
      CLIPROXYAPI_BASE_URL: root,
      CLIPROXY_MANAGEMENT_KEY: managementKey,
    },
    providerId: "cliproxyapi",
  });

const exhaustedMarks = async (agentDir: URL): Promise<Record<string, number>> =>
  JSON.parse(
    await readFile(new URL("cliproxyapi-usage.json", agentDir), "utf-8")
  ).exhausted;

const STILL_WAITING = "still waiting on the management API";

test("Claude's account rate limit 429 marks the model out until its full 5h window resets", async (t) => {
  const management = await startManagement();
  t.after(() => management.close());
  const agentDir = await usageAgentDir("rate-limit-usage-agent");

  const tracker = managedTracker(
    agentDir,
    management.root,
    "management-test-key"
  );

  assert.equal(
    await tracker.recordError("claude-opus-5-5", CLAUDE_ACCOUNT_RATE_LIMIT),
    true
  );
  await tracker.refresh(true);

  assert.deepEqual(await exhaustedMarks(agentDir), {
    "claude-opus-5-5": CLAUDE_5H_RESET_SECONDS * 1000,
  });
});

test("a quota error hides the model at once while the management API hangs", async (t) => {
  const management = await startManagement();
  t.after(() => management.close());
  const agentDir = await usageAgentDir("rate-limit-hang-agent");
  const tracker = managedTracker(agentDir, management.root, HELD_KEY);

  const recorded = await Promise.race([
    Promise.resolve(
      tracker.recordError("claude-opus-5-5", CLAUDE_ACCOUNT_RATE_LIMIT)
    ),
    setTimeout(1000, STILL_WAITING),
  ]);

  assert.equal(recorded, true);
  assert.equal(tracker.hidden().has("claude-opus-5-5"), true);
});

test("a reset time named in the error holds while the management API hangs", async (t) => {
  const management = await startManagement();
  t.after(() => management.close());
  const agentDir = await usageAgentDir("rate-limit-named-agent");
  const tracker = managedTracker(agentDir, management.root, HELD_KEY);
  const resetsAt = Math.floor(Date.now() / 1000) + 3;

  // The shape CLIProxyAPI returned for an exhausted Muse account, with a reset 3 s away.
  await tracker.recordError(
    "muse-spark-1.3",
    `cliproxyapi API error (429): {"code":"rate_limit_exceeded","message":"Subscription quota exhausted.","param":null,"resets_at":${resetsAt},"type":"rate_limit_error"}`
  );

  assert.deepEqual(await exhaustedMarks(agentDir), {
    "muse-spark-1.3": resetsAt * 1000,
  });
});

test("a cooldown reset in another pi process stays reset when the usage fetch after a quota error finishes", async (t) => {
  const management = await startManagement();
  t.after(() => management.close());
  const agentDir = await usageAgentDir("rate-limit-reset-agent");
  const recorder = managedTracker(agentDir, management.root, HELD_KEY);
  const resetter = managedTracker(agentDir, management.root, "reset-key");

  const recording = Promise.resolve(
    recorder.recordError("claude-opus-5-5", CLAUDE_ACCOUNT_RATE_LIMIT)
  );

  const refreshing = recorder.refresh(true);

  assert.deepEqual(await resetter.resetCooldowns("claude-opus-5-5"), [
    "claude-opus-5-5",
  ]);
  management.release();
  await Promise.all([recording, refreshing]);

  assert.equal(resetter.hidden().has("claude-opus-5-5"), false);
});

test("Claude's account rate limit 429 without a management key marks the model out for 15 minutes", async () => {
  const agentDir = new URL("rate-limit-fallback-agent/", outputDirectory);
  await rm(agentDir, { force: true, recursive: true });
  await mkdir(agentDir, { recursive: true });

  const tracker = new UsageTracker({
    agentDir: agentDir.pathname,
    env: {},
    providerId: "cliproxyapi",
  });

  const before = Date.now();
  assert.equal(
    await tracker.recordError("claude-opus-5-5", CLAUDE_ACCOUNT_RATE_LIMIT),
    true
  );
  const after = Date.now();
  const marks = await exhaustedMarks(agentDir);
  const until = marks["claude-opus-5-5"] ?? 0;

  assert.ok(until >= before + QUOTA_FALLBACK_MS);
  assert.ok(until <= after + QUOTA_FALLBACK_MS);
});

test("registered family APIs, configured thought summaries, and live Fast tier work in one session", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const agentDir = new URL("provider-agent/", outputDirectory);
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    new URL("cliproxyapi.json", agentDir),
    `${JSON.stringify(
      { thinkingDisplay: { "claude-haiku-5-5": "summarized" } },
      null,
      2
    )}\n`
  );

  const connection = resolveExtensionConnection({
    agentDir: agentDir.pathname,
    env: {
      CLIPROXYAPI_API_KEY: "extension-test-key",
      CLIPROXYAPI_BASE_URL: proxy.root,
    },
    providerId: "cliproxyapi",
  });

  assert.ok(connection);
  const fast = new FastModeController(false);

  const extensionProvider = createExtensionProvider({
    agentDir: agentDir.pathname,
    connection,
    costsUrl: `${proxy.root}/costs`,
    fast,
    providerId: "cliproxyapi",
    providerName: "CLIProxyAPI",
  });

  const models = createModels();
  models.setProvider(extensionProvider.provider);
  const refreshed = await models.refresh({ providers: ["cliproxyapi"] });
  assert.equal(refreshed.errors.size, 0);

  const claude = models.getModel("cliproxyapi", "claude-haiku-5-5");
  const gpt = models.getModel("cliproxyapi", "gpt-6-luna");
  assert.equal(claude?.api, "anthropic-messages");
  assert.equal(gpt?.api, "openai-responses");
  assert.ok(claude && gpt);

  const context = {
    messages: [{ content: "Say ok", role: "user" as const, timestamp: 1 }],
  };

  const claudeResult = await models.complete(claude, context, {
    thinkingEnabled: true,
  });

  assert.equal(claudeResult.stopReason, "stop", claudeResult.errorMessage);
  assert.equal(proxy.requests.at(-1)?.body.thinking?.display, "summarized");

  const originalProvider = models.getProvider("cliproxyapi");
  const originalModel = models.getModel("cliproxyapi", "gpt-6-luna");
  const standard = await models.completeSimple(gpt, context);
  assert.equal(standard.stopReason, "stop", standard.errorMessage);
  assert.equal(proxy.requests.at(-1)?.body.service_tier, undefined);

  const notifications: string[] = [];

  const toggled = await toggleFastMode({
    agentDir: agentDir.pathname,
    fast,
    notify: (message) => notifications.push(message),
    refresh: async () => {
      const result = await models.refresh({
        force: true,
        providers: ["cliproxyapi"],
      });

      assert.equal(result.errors.size, 0);
    },
  });

  assert.equal(toggled, true);
  assert.ok(notifications.some((message) => message.includes("enabled")));
  assert.equal(models.getModel("cliproxyapi", "gpt-6-luna")?.cost.input, 4);

  const priority = await models.completeSimple(gpt, context, {
    onPayload: expectPriorityThenTag,
  });

  assert.equal(priority.stopReason, "stop", priority.errorMessage);
  assert.equal(proxy.requests.at(-1)?.body.service_tier, "priority");
  assert.deepEqual(proxy.requests.at(-1)?.body.metadata, {
    caller: "final-hook",
  });
  assert.equal(models.getProvider("cliproxyapi"), originalProvider);
  assert.equal(
    models.getModel("cliproxyapi", "gpt-6-luna")?.id,
    originalModel?.id
  );

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    new URL("requests.json", outputDirectory),
    `${JSON.stringify(proxy.requests, null, 2)}\n`
  );

  const cacheUrl = new URL("cliproxyapi-provider-models.json", agentDir);
  const cacheText = await readFile(cacheUrl, "utf-8");
  const cache = JSON.parse(cacheText);

  assert.equal(cache.models.length, 2);
  const formattedCache = await format(cacheUrl.pathname, cacheText);
  assert.deepEqual(formattedCache.errors, []);
  await writeFile(cacheUrl, formattedCache.code);
});

test("the first price load fetches models.dev once and saves only the catalog's prices", async (t) => {
  const { prices, pricesFile, proxy } = await startPriceCache(
    "prices-first-agent",
    (cleanup) => t.after(cleanup)
  );

  const loaded = await prices.load(catalogIds);

  assert.equal(proxy.costRequests().length, 1);
  assert.equal(loaded.warning, undefined);
  assert.deepEqual(matchModelCost("claude-haiku-5-5", loaded.catalog), {
    cacheRead: 0,
    cacheWrite: 0,
    input: 1,
    output: 5,
  });
  assert.equal(matchModelCost("gpt-6-luna", loaded.catalog).input, 2);
  assert.equal(matchModelCost("gpt-6-luna", loaded.catalog, true).input, 4);

  const saved = JSON.parse(await readFile(pricesFile, "utf-8"));
  assert.equal(saved.etag, COSTS_ETAG);
  assert.deepEqual(Object.keys(saved.prices), catalogIds);
});

test("prices under 24 hours old load without a models.dev request", async (t) => {
  const { clock, prices, proxy } = await startPriceCache(
    "prices-fresh-agent",
    (cleanup) => t.after(cleanup)
  );

  await prices.load(catalogIds);
  clock.now += 23 * 60 * 60 * 1000;
  const loaded = await prices.load(catalogIds);

  assert.equal(proxy.costRequests().length, 1);
  assert.equal(loaded.warning, undefined);
  assert.equal(matchModelCost("gpt-6-luna", loaded.catalog).input, 2);
});

test("prices over 24 hours old revalidate with If-None-Match and keep the prices on 304", async (t) => {
  const { clock, prices, proxy } = await startPriceCache(
    "prices-revalidate-agent",
    (cleanup) => t.after(cleanup)
  );

  await prices.load(catalogIds);
  clock.now += DAY_MS + 60 * 60 * 1000;
  const loaded = await prices.load(catalogIds);

  assert.equal(proxy.costRequests().length, 2);
  assert.equal(proxy.costRequests().at(-1)?.ifNoneMatch, COSTS_ETAG);
  assert.equal(loaded.warning, undefined);
  assert.equal(matchModelCost("gpt-6-luna", loaded.catalog, true).input, 4);

  // The 304 restarts the 24 hours, so the next load makes no request.
  await prices.load(catalogIds);
  assert.equal(proxy.costRequests().length, 2);
});

test("a new catalog id fetches every price again without If-None-Match", async (t) => {
  const { pricesFile, prices, proxy } = await startPriceCache(
    "prices-new-id-agent",
    (cleanup) => t.after(cleanup)
  );

  await prices.load(catalogIds);
  const loaded = await prices.load([...catalogIds, "grok-4.3"]);

  assert.equal(proxy.costRequests().length, 2);
  assert.equal(proxy.costRequests().at(-1)?.ifNoneMatch, undefined);
  assert.equal(matchModelCost("grok-4.3", loaded.catalog).input, 0);

  const saved = JSON.parse(await readFile(pricesFile, "utf-8"));
  assert.equal(saved.prices["grok-4.3"], null);
});

test("a models.dev outage keeps cached prices and warns with the reason and their age", async (t) => {
  const { clock, prices, proxy } = await startPriceCache(
    "prices-outage-agent",
    (cleanup) => t.after(cleanup)
  );

  await prices.load(catalogIds);
  clock.now += 3 * DAY_MS;
  proxy.costsOutage.status = 503;
  const loaded = await prices.load(catalogIds);

  assert.equal(matchModelCost("gpt-6-luna", loaded.catalog).input, 2);
  assert.equal(
    loaded.warning,
    "Couldn't update prices from models.dev (HTTP 503). Using prices from 3 days ago."
  );
});

test("a models.dev outage with no cached prices zeroes costs and says so", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  proxy.costsOutage.status = 503;
  const agentDir = new URL("prices-none-agent/", outputDirectory);
  await rm(agentDir, { force: true, recursive: true });

  const connection = resolveExtensionConnection({
    agentDir: agentDir.pathname,
    env: {
      CLIPROXYAPI_API_KEY: "extension-test-key",
      CLIPROXYAPI_BASE_URL: proxy.root,
    },
    providerId: "cliproxyapi",
  });

  assert.ok(connection);
  const warnings: string[] = [];

  const extensionProvider = createExtensionProvider({
    agentDir: agentDir.pathname,
    connection,
    costsUrl: `${proxy.root}/costs`,
    fast: new FastModeController(false),
    onPriceWarning: (message) => warnings.push(message),
    providerId: "cliproxyapi",
    providerName: "CLIProxyAPI",
  });

  const [claude, gpt] = await extensionProvider.refresh(connection);
  const zero = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };

  assert.deepEqual(claude?.cost, zero);
  assert.deepEqual(gpt?.cost, zero);
  assert.deepEqual(warnings, [
    "Couldn't load prices from models.dev (HTTP 503). Costs show $0 until prices load.",
  ]);
});

const MINUTE_MS = 60 * 1000;

/** A provider over a fresh proxy and empty agent dir, registered with pi-ai, with a clock the test moves. */
const startCatalogRefresh = async (
  name: string,
  register: (cleanup: () => Promise<void>) => void
) => {
  const proxy = await startProxy();
  register(() => proxy.close());
  const agentDir = new URL(`${name}/`, outputDirectory);
  await rm(agentDir, { force: true, recursive: true });
  const clock = { now: Date.parse("2026-10-29T12:00:00Z") };

  const connection = resolveExtensionConnection({
    agentDir: agentDir.pathname,
    env: {
      CLIPROXYAPI_API_KEY: "extension-test-key",
      CLIPROXYAPI_BASE_URL: proxy.root,
    },
    providerId: "cliproxyapi",
  });

  assert.ok(connection);

  const extensionProvider = createExtensionProvider({
    agentDir: agentDir.pathname,
    connection,
    costsUrl: `${proxy.root}/costs`,
    fast: new FastModeController(false),
    now: () => clock.now,
    providerId: "cliproxyapi",
    providerName: "CLIProxyAPI",
  });

  const models = createModels();
  models.setProvider(extensionProvider.provider);

  return {
    catalogRequests: () =>
      proxy.requests.filter((request) => request.url.startsWith("/v1/models")),
    clock,
    extensionProvider,
    models,
  };
};

test("two refreshes in a row fetch the catalog once", async (t) => {
  const { catalogRequests, clock, extensionProvider, models } =
    await startCatalogRefresh("catalog-ttl-agent", (cleanup) =>
      t.after(cleanup)
    );

  assert.equal(extensionProvider.getCatalogFetchedAt(), 0);
  await models.refresh({ providers: ["cliproxyapi"] });
  await models.refresh({ providers: ["cliproxyapi"] });

  assert.equal(catalogRequests().length, 1);
  assert.equal(extensionProvider.getCatalogFetchedAt(), clock.now);
  assert.ok(models.getModel("cliproxyapi", "gpt-6-luna"));
});

test("a forced refresh fetches the catalog even when it is fresh", async (t) => {
  const { catalogRequests, models } = await startCatalogRefresh(
    "catalog-force-agent",
    (cleanup) => t.after(cleanup)
  );

  await models.refresh({ providers: ["cliproxyapi"] });
  await models.refresh({ providers: ["cliproxyapi"] });
  await models.refresh({ force: true, providers: ["cliproxyapi"] });

  assert.equal(catalogRequests().length, 2);
});

test("a refresh after 10 minutes fetches the catalog again", async (t) => {
  const { catalogRequests, clock, extensionProvider, models } =
    await startCatalogRefresh("catalog-stale-agent", (cleanup) =>
      t.after(cleanup)
    );

  await models.refresh({ providers: ["cliproxyapi"] });
  clock.now += 11 * MINUTE_MS;
  await models.refresh({ providers: ["cliproxyapi"] });

  assert.equal(catalogRequests().length, 2);
  assert.equal(extensionProvider.getCatalogFetchedAt(), clock.now);
});

test("a refresh gives Claude models pi's prompt cache lifetimes", async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const agentDir = new URL("prompt-cache-agent/", outputDirectory);
  await rm(agentDir, { force: true, recursive: true });

  const connection = resolveExtensionConnection({
    agentDir: agentDir.pathname,
    env: {
      CLIPROXYAPI_API_KEY: "prompt-cache-key",
      CLIPROXYAPI_BASE_URL: proxy.root,
    },
    providerId: "cliproxyapi",
  });

  assert.ok(connection);

  const extensionProvider = createExtensionProvider({
    agentDir: agentDir.pathname,
    connection,
    costsUrl: `${proxy.root}/costs`,
    fast: new FastModeController(false),
    providerId: "cliproxyapi",
    providerName: "CLIProxyAPI",
  });

  const models = createModels();
  models.setProvider(extensionProvider.provider);
  const refreshed = await models.refresh({ providers: ["cliproxyapi"] });
  assert.equal(refreshed.errors.size, 0);

  assert.deepEqual(
    models.getModel("cliproxyapi", "claude-haiku-5-5")?.promptCache,
    { long: 3600, short: 300 }
  );
  assert.equal(
    models.getModel("cliproxyapi", "gpt-6-luna")?.promptCache,
    undefined
  );
});

test("formatStatus shows the whole state in the agreed seven lines", () => {
  const status = formatStatus({
    baseUrl: "http://127.0.0.1:8317",
    catalogAgeMs: 4 * 60_000 + 20_000,
    fast: true,
    fastModels: 8,
    keySource: "login",
    management: { source: "env", usageAgeMs: 75_000 },
    models: 17,
    paused: false,
    prices: { ageMs: 3 * 3_600_000 + 600_000, etag: '"94aeb98e1f0c7d2a"' },
    searchModel: { effective: "gpt-6-luna" },
    stale: 1,
    thinking: { "claude-opus-5-5": "summarized" },
  });

  assert.equal(
    status,
    [
      "CLIProxyAPI  http://127.0.0.1:8317  key from auth.json (/login)",
      "Models       17 (1 stale), catalog 4 min old",
      "Prices       models.dev, 3 h old (etag 94aeb98e)",
      "Fast         on (8 models support it)    Paused  no",
      "Management   key set (env CLIPROXY_MANAGEMENT_KEY), usage 1 min old",
      "Web search   auto (gpt-6-luna)",
      "Thinking     summarized: claude-opus-5-5",
    ].join("\n")
  );
});

test("formatStatus without an API key or management key says so", () => {
  const status = formatStatus({
    baseUrl: "http://127.0.0.1:8317",
    fast: false,
    fastModels: 0,
    models: 0,
    paused: true,
    searchModel: {},
    stale: 0,
    thinking: {},
  });

  assert.equal(
    status,
    [
      "CLIProxyAPI  http://127.0.0.1:8317  not configured",
      "Models       0, catalog not fetched",
      "Prices       not loaded",
      "Fast         off (0 models support it)    Paused  yes",
      "Management   not set",
      "Web search   auto (none available)",
      "Thinking     omitted for all models",
    ].join("\n")
  );
});

test("the status never shows the API key or the management key", async () => {
  const agentDir = new URL("status-agent/", outputDirectory);
  await rm(agentDir, { force: true, recursive: true });
  saveCliproxyConfig(agentDir.pathname, {
    apiKey: "SENTINEL-FILE-API-KEY",
    managementKey: "SENTINEL-FILE-MANAGEMENT-KEY",
    searchModel: "gpt-6-luna",
  });
  const config = loadCliproxyConfig(agentDir.pathname);
  const stored = loadStoredConnection(agentDir.pathname, "cliproxyapi");

  const envOptions = {
    agentDir: agentDir.pathname,
    env: {
      CLIPROXYAPI_API_KEY: "SENTINEL-ENV-API-KEY",
      CLIPROXY_MANAGEMENT_KEY: "SENTINEL-ENV-MANAGEMENT-KEY",
    },
    providerId: "cliproxyapi",
  };

  const fromEnv = formatStatus({
    baseUrl: "http://127.0.0.1:8317",
    fast: false,
    fastModels: 0,
    keySource: resolveConnectionSources(envOptions.env, config, stored).apiKey,
    management: new UsageTracker(envOptions).managementStatus(),
    models: 0,
    paused: false,
    searchModel: { configured: config.searchModel },
    stale: 0,
    thinking: {},
  });

  const fromFile = formatStatus({
    baseUrl: "http://127.0.0.1:8317",
    fast: false,
    fastModels: 0,
    keySource: resolveConnectionSources({}, config, stored).apiKey,
    management: new UsageTracker({
      agentDir: agentDir.pathname,
      env: {},
      providerId: "cliproxyapi",
    }).managementStatus(),
    models: 0,
    paused: false,
    searchModel: { configured: config.searchModel },
    stale: 0,
    thinking: {},
  });

  assert.match(fromEnv, /key from env CLIPROXYAPI_API_KEY/u);
  assert.match(fromEnv, /key set \(env CLIPROXY_MANAGEMENT_KEY\)/u);
  assert.match(fromFile, /key from cliproxyapi\.json/u);
  assert.match(fromFile, /key set \(cliproxyapi\.json\)/u);
  assert.doesNotMatch(`${fromEnv}\n${fromFile}`, /SENTINEL/u);
});

test("completeFrom completes command arguments by case-insensitive prefix", () => {
  const ids = ["auto", "claude-haiku-5-5", "Claude-Sonnet-5", "gpt-5.5"];

  assert.deepEqual(completeFrom(ids, "CLA"), [
    { label: "claude-haiku-5-5", value: "claude-haiku-5-5" },
    { label: "Claude-Sonnet-5", value: "Claude-Sonnet-5" },
  ]);
  assert.deepEqual(
    completeFrom(ids, ""),
    ids.map((id) => ({ label: id, value: id }))
  );
  assert.equal(completeFrom(ids, "gemini"), null);
});

const tpsUsage = {
  cacheRead: 15_402,
  cacheWrite: 0,
  input: 2301,
  output: 1036,
  total: 18_739,
};

test("formatTpsSummary shows speed over generation time, run length, and cache hit rate", () => {
  assert.equal(
    formatTpsSummary(tpsUsage, 12_300, 40_100),
    "TPS 84.2 tok/s (12.3s generating of 40.1s). out 1,036, in 2,301, cache hit 87% (r/w 15,402/0), total 18,739"
  );
});

test("formatTpsSummary without generation time shows no speed", () => {
  assert.equal(
    formatTpsSummary(tpsUsage, 0, 40_100),
    "TPS -- tok/s (0.0s generating of 40.1s). out 1,036, in 2,301, cache hit 87% (r/w 15,402/0), total 18,739"
  );
});

test("formatTpsSummary without any input shows no cache hit rate", () => {
  assert.equal(
    formatTpsSummary(
      { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
      12_300,
      40_100
    ),
    "TPS 0.0 tok/s (12.3s generating of 40.1s). out 0, in 0, cache hit -- (r/w 0/0), total 0"
  );
});
