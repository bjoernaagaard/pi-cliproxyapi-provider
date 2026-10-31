// Check 3: a caller's onPayload cache mark survives when the prompt grows in the middle.
import { randomUUID } from "node:crypto";

import type { StreamOptions } from "@earendil-works/pi-ai";

import { createCheck, liveModels, saveOutput } from "./live.ts";

const MODEL_ID = "claude-haiku-5-5";
const check = createCheck("cache-marks");
const models = await liveModels();
const model = models.getModel("cliproxyapi", MODEL_ID);

if (!model) {
  throw new Error(`${MODEL_ID} is missing from the catalog`);
}

// A fresh nonce keeps the first request from hitting an earlier run's cache.
const nonce = randomUUID();

const document = [
  `Reference manual ${nonce}.`,
  ...Array.from(
    { length: 900 },
    (_, index) =>
      `Rule ${index + 1}: station ${index % 37} reports to depot ${(index * 7) % 101} every ${(index % 9) + 1} hours.`
  ),
].join("\n");

const question =
  "Which depot does station 5 report to under rule 6? Answer with the number only.";

const inserted = Array.from(
  { length: 6 },
  (_, index) => `Late note ${index + 1}: depot ${index + 200} opened today.`
).join("\n");

interface AnthropicPayload {
  messages: {
    content:
      | string
      | { type: string; text?: string; cache_control?: unknown }[];
  }[];
  system?: { cache_control?: unknown }[];
}

const captured: unknown[] = [];

// The caller marks the document block, the last block both requests share.
const markDocument: NonNullable<StreamOptions["onPayload"]> = (payload) => {
  // SAFETY: The Anthropic Messages adapter supplies this request body.
  const body = payload as AnthropicPayload;
  const [first] = body.messages;

  if (first && Array.isArray(first.content) && first.content[0]) {
    first.content[0].cache_control = { type: "ephemeral" };
  }

  captured.push(structuredClone(body));

  return body;
};

const ask = async (blocks: string[]) => {
  const message = await models.complete(
    model,
    {
      messages: [
        {
          content: blocks.map((text) => ({ text, type: "text" as const })),
          role: "user",
          timestamp: Date.now(),
        },
      ],
    },
    // "none" turns off pi-ai's own marks, so any cache hit comes from the caller's mark.
    { cacheRetention: "none", onPayload: markDocument }
  );

  return {
    errorMessage: message.errorMessage,
    stopReason: message.stopReason,
    text: message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(""),
    usage: message.usage,
  };
};

const first = await ask([document, question]);
const second = await ask([document, inserted, question]);

for (const [name, turn] of [
  ["first", first],
  ["second", second],
] as const) {
  check.expect(
    turn.stopReason === "stop",
    `${name} request: ${turn.errorMessage}`
  );
}

check.expect(first.usage.cacheWrite > 0, "first request wrote no cache");

check.expect(
  second.usage.cacheRead > 0,
  `second request read ${second.usage.cacheRead} cached tokens`
);

const marks = captured.map(
  (body) => JSON.stringify(body).split('"cache_control"').length - 1
);

check.expect(
  marks.every((count) => count === 1),
  `expected exactly one cache mark per request, saw ${marks.join(", ")}`
);

const result = check.finish();

await saveOutput("cache-marks", {
  ...result,
  cacheMarksPerRequest: marks,
  documentChars: document.length,
  first,
  model: MODEL_ID,
  requestBlocks: captured.map((body) => {
    // SAFETY: Each captured value is an Anthropic request body pushed above.
    const { messages } = body as AnthropicPayload;
    const content = messages[0]?.content;

    return Array.isArray(content)
      ? content.map((block) => ({
          cacheControl: block.cache_control ?? null,
          chars: block.text?.length ?? 0,
        }))
      : content;
  }),
  second,
});
