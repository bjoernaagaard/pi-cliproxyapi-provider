// Check 2: one real chat turn per model family returns text and usage on its chosen API.
import { MODEL_API_BY_FAMILY } from "../../src/core/index.ts";
import type { ModelFamilies } from "../../src/core/index.ts";
import { FAMILY_MODELS, createCheck, liveModels, saveOutput } from "./live.ts";

// CHAT_FAMILIES='{"*":"openai-completions","claude-*":"anthropic-messages"}' compares another API choice.
const families: ModelFamilies = process.env.CHAT_FAMILIES
  ? JSON.parse(process.env.CHAT_FAMILIES)
  : MODEL_API_BY_FAMILY;

const outputName = process.env.CHAT_OUTPUT ?? "chat-families";
const check = createCheck(outputName);
const models = await liveModels({ families });

const context = {
  messages: [
    {
      content: "What is the capital of France? Answer with one word.",
      role: "user" as const,
      timestamp: Date.now(),
    },
  ],
};

const turns = await Promise.all(
  FAMILY_MODELS.map(async (id) => {
    const model = models.getModel("cliproxyapi", id);

    if (!model) {
      check.expect(false, `${id} is missing from the catalog`);

      return { id, missing: true };
    }

    const startedAt = Date.now();

    // Pi sends a thinking level on every turn, so reasoning models get one here too.
    const message = await models.completeSimple(
      model,
      context,
      model.reasoning ? { reasoning: "low" } : {}
    );

    const text = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("")
      .trim();

    check.expect(
      message.stopReason === "stop",
      `${id} stopped with ${message.stopReason}: ${message.errorMessage ?? ""}`
    );
    check.expect(
      text.toLowerCase().includes("paris"),
      `${id} text was ${JSON.stringify(text)}`
    );
    check.expect(
      message.usage.input > 0 || message.usage.cacheRead > 0,
      `${id} reported no input tokens`
    );
    check.expect(message.usage.output > 0, `${id} reported no output tokens`);

    return {
      api: model.api,
      contentTypes: message.content.map((part) => part.type),
      durationMs: Date.now() - startedAt,
      errorMessage: message.errorMessage,
      id,
      stopReason: message.stopReason,
      text,
      usage: message.usage,
    };
  })
);

const result = check.finish();

await saveOutput(outputName, { ...result, families, turns });
