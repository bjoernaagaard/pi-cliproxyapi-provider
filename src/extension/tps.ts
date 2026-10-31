import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { PauseController } from "./pause.ts";

const STATUS_KEY = "tps";
const REFRESH_INTERVAL_MS = 1000;

const primaryUi = (ctx: ExtensionContext): boolean =>
  ctx.hasUI && ctx.mode === "tui";

const formatElapsed = (totalSeconds: number): string => {
  const safe = Math.max(0, Math.floor(totalSeconds));

  const units = [
    { suffix: "d", value: Math.floor(safe / 86_400) },
    { suffix: "h", value: Math.floor((safe % 86_400) / 3600) },
    { suffix: "m", value: Math.floor((safe % 3600) / 60) },
    { suffix: "s", value: safe % 60 },
  ];

  const first = units.findIndex(
    (unit, index) => unit.value > 0 || index === units.length - 1
  );

  return units
    .slice(first)
    .map((unit) => `${unit.value}${unit.suffix}`)
    .join(" ");
};

export interface TpsUsage {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  total: number;
}

const PERCENT = 100;
const MS_PER_SECOND = 1000;

const count = (value: number): string => value.toLocaleString("en-US");

const seconds = (ms: number): string => (ms / MS_PER_SECOND).toFixed(1);

/** The run summary: output speed over generation time, run length, and cache hit rate. */
export const formatTpsSummary = (
  usage: TpsUsage,
  generationMs: number,
  wallMs: number
): string => {
  const tps =
    generationMs > 0
      ? (usage.output / (generationMs / MS_PER_SECOND)).toFixed(1)
      : "--";

  const prompt = usage.input + usage.cacheRead;

  const cacheHit =
    prompt > 0 ? `${Math.round((usage.cacheRead / prompt) * PERCENT)}%` : "--";

  return `TPS ${tps} tok/s (${seconds(generationMs)}s generating of ${seconds(wallMs)}s). out ${count(usage.output)}, in ${count(usage.input)}, cache hit ${cacheHit} (r/w ${count(usage.cacheRead)}/${count(usage.cacheWrite)}), total ${count(usage.total)}`;
};

const emptyUsage = (): TpsUsage => ({
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
  total: 0,
});

const isProviderAssistant = (
  message: { role: string; provider?: unknown },
  providerId: string
): boolean => message.role === "assistant" && message.provider === providerId;

export const registerTpsFooter = (
  pi: ExtensionAPI,
  pause: PauseController,
  providerId: string
): void => {
  let startedAt: number | undefined;
  let pausedAtStart = 0;
  let pauseAtStart = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let statusContext: ExtensionContext | undefined;
  let usage = emptyUsage();
  let generationMs = 0;
  let generationStartedAt: number | undefined;

  const clearTimer = (): void => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  const elapsed = (): number => {
    if (startedAt === undefined) {
      return 0;
    }

    return pauseAtStart
      ? pause.getElapsed(startedAt, pausedAtStart)
      : Math.max(0, Date.now() - startedAt);
  };

  const showElapsed = (ctx: ExtensionContext): void => {
    if (primaryUi(ctx)) {
      ctx.ui.setStatus(
        STATUS_KEY,
        ctx.ui.theme.fg("dim", `Elapsed ${formatElapsed(elapsed() / 1000)}`)
      );
    }
  };

  pi.on("before_agent_start", (_event, ctx) => {
    if (!primaryUi(ctx)) {
      return;
    }

    statusContext = ctx;

    if (startedAt !== undefined) {
      return;
    }

    startedAt = Date.now();
    pauseAtStart = pause.isEnabled();
    pausedAtStart = pause.getPausedDuration(startedAt);
    usage = emptyUsage();
    generationMs = 0;
    generationStartedAt = undefined;
    showElapsed(ctx);
    clearTimer();
    timer = setInterval(() => {
      if (statusContext) {
        showElapsed(statusContext);
      }
    }, REFRESH_INTERVAL_MS);
    timer.unref();
  });

  pi.on("message_start", (event) => {
    if (
      startedAt !== undefined &&
      isProviderAssistant(event.message, providerId)
    ) {
      generationStartedAt = Date.now();
    }
  });

  pi.on("message_end", (event) => {
    if (
      generationStartedAt === undefined ||
      !isProviderAssistant(event.message, providerId)
    ) {
      return;
    }

    generationMs += Math.max(0, Date.now() - generationStartedAt);
    generationStartedAt = undefined;
  });

  pi.on("agent_end", (event, ctx) => {
    if (startedAt === undefined || !primaryUi(ctx)) {
      return;
    }

    for (const message of event.messages) {
      if (message.role !== "assistant" || message.provider !== providerId) {
        continue;
      }

      usage.input += message.usage.input;
      usage.output += message.usage.output;
      usage.cacheRead += message.usage.cacheRead;
      usage.cacheWrite += message.usage.cacheWrite;
      usage.total += message.usage.totalTokens;
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (startedAt === undefined || !primaryUi(ctx)) {
      return;
    }

    const elapsedMs = elapsed();
    showElapsed(ctx);
    startedAt = undefined;
    clearTimer();
    statusContext = ctx;

    if (elapsedMs <= 0) {
      return;
    }

    ctx.ui.notify(formatTpsSummary(usage, generationMs, elapsedMs), "info");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearTimer();

    if (primaryUi(ctx)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }

    startedAt = undefined;
    statusContext = undefined;
  });
};
