// Check 4: with the default thought-summary setting, Claude text streams over time.
import type { StreamOptions } from "@earendil-works/pi-ai";

import type { ThoughtSummary } from "../../src/core/index.ts";
import { createCheck, liveModels, saveOutput } from "./live.ts";

const MODEL_ID = "claude-haiku-5-5";
const check = createCheck("claude-streaming");

const run = async (thoughtSummaries?: Record<string, ThoughtSummary>) => {
  const models = await liveModels(thoughtSummaries ? { thoughtSummaries } : {});
  const model = models.getModel("cliproxyapi", MODEL_ID);

  if (!model) {
    throw new Error(`${MODEL_ID} is missing from the catalog`);
  }

  let thinking: unknown;

  const onPayload: NonNullable<StreamOptions["onPayload"]> = (payload) => {
    // SAFETY: The Anthropic Messages adapter supplies this request body.
    ({ thinking } = payload as { thinking?: unknown });
  };

  const startedAt = performance.now();
  const textDeltas: number[] = [];
  const thinkingDeltas: number[] = [];
  let stopReason = "";
  let errorMessage: string | undefined;

  const stream = models.streamSimple(
    model,
    {
      messages: [
        {
          content: "Write about 250 words on the history of the bicycle.",
          role: "user",
          timestamp: Date.now(),
        },
      ],
    },
    { onPayload, reasoning: "medium" }
  );

  for await (const event of stream) {
    const at = Math.round(performance.now() - startedAt);

    if (event.type === "text_delta") {
      textDeltas.push(at);
    } else if (event.type === "thinking_delta") {
      thinkingDeltas.push(at);
    } else if (event.type === "done") {
      ({ stopReason } = event.message);
    } else if (event.type === "error") {
      ({ stopReason, errorMessage } = event.error);
    }
  }

  const totalMs = Math.round(performance.now() - startedAt);
  const first = textDeltas[0] ?? totalMs;
  const last = textDeltas.at(-1) ?? totalMs;

  const lateShare =
    textDeltas.filter((at) => at >= totalMs * 0.9).length /
    Math.max(1, textDeltas.length);

  return {
    errorMessage,
    lateShare: Number(lateShare.toFixed(3)),
    requestThinking: thinking,
    stopReason,
    textDeltaCount: textDeltas.length,
    textDeltaTimesMs: textDeltas,
    textSpanMs: last - first,
    thinkingDeltaCount: thinkingDeltas.length,
    thinkingDeltaTimesMs: thinkingDeltas,
    totalMs,
  };
};

const defaultRun = await run();

// The opposite setting, for contrast only. Fact 6 says it arrives in one late burst.
const summarizedRun = await run({ [MODEL_ID]: "summarized" });

check.expect(
  defaultRun.stopReason === "stop",
  `default run stopped with ${defaultRun.stopReason}: ${defaultRun.errorMessage}`
);

check.expect(
  !JSON.stringify(defaultRun.requestThinking ?? {}).includes("summarized"),
  `default request asked for summarized thinking: ${JSON.stringify(defaultRun.requestThinking)}`
);

check.expect(
  defaultRun.textDeltaCount >= 10,
  `only ${defaultRun.textDeltaCount} text deltas`
);

check.expect(
  defaultRun.textSpanMs >= 1000,
  `text deltas spanned only ${defaultRun.textSpanMs} ms`
);

check.expect(
  defaultRun.lateShare < 0.5,
  `${defaultRun.lateShare * 100}% of text deltas arrived in the last 10% of the response`
);

const result = check.finish();

await saveOutput("claude-streaming", {
  ...result,
  default: defaultRun,
  model: MODEL_ID,
  summarizedForContrast: summarizedRun,
});
