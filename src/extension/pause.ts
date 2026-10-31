/* oxlint-disable eslint/no-await-in-loop -- Pause polling must read each setting change before the next timed wait. */
import { setTimeout as delay } from "node:timers/promises";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { loadCliproxyConfig, saveCliproxyConfig } from "./config.ts";

const POLL_INTERVAL_MS = 200;

export class PauseController {
  private enabled: boolean;
  private pauseStartedAt: number | undefined;
  private pausedDuration = 0;

  constructor(enabled = false) {
    this.enabled = enabled;

    if (enabled) {
      this.pauseStartedAt = Date.now();
    }
  }

  setEnabled(enabled: boolean, now = Date.now()): void {
    if (enabled === this.enabled) {
      return;
    }

    if (enabled) {
      this.pauseStartedAt = now;
    } else if (this.pauseStartedAt !== undefined) {
      this.pausedDuration += Math.max(0, now - this.pauseStartedAt);
      this.pauseStartedAt = undefined;
    }

    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPausedDuration(now = Date.now()): number {
    return (
      this.pausedDuration +
      (this.pauseStartedAt === undefined
        ? 0
        : Math.max(0, now - this.pauseStartedAt))
    );
  }

  getElapsed(start: number, pausedAtStart: number, now = Date.now()): number {
    return Math.max(
      0,
      now - start - Math.max(0, this.getPausedDuration(now) - pausedAtStart)
    );
  }
}

export const waitForPauseToEnd = async (
  agentDir: string,
  pause: PauseController,
  signal?: AbortSignal
): Promise<void> => {
  while (true) {
    signal?.throwIfAborted();

    try {
      pause.setEnabled(loadCliproxyConfig(agentDir).pause ?? false);
    } catch {
      // Keep the last in-memory setting when the configuration cannot be read.
    }

    if (!pause.isEnabled()) {
      return;
    }

    await delay(POLL_INTERVAL_MS);
  }
};

export const registerPause = (
  pi: ExtensionAPI,
  agentDir: string,
  pause: PauseController
): void => {
  const setPause = (
    enabled: boolean,
    args: string,
    ctx: ExtensionCommandContext
  ): void => {
    if (args.trim()) {
      ctx.ui.notify(`Usage: /${enabled ? "pause" : "continue"}`, "error");

      return;
    }

    try {
      saveCliproxyConfig(agentDir, { pause: enabled });
      pause.setEnabled(enabled);
      ctx.ui.notify(
        enabled ? "Requests are paused." : "Requests are continued.",
        "info"
      );
    } catch (error) {
      ctx.ui.notify(
        `Failed to save pause mode: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  };

  pi.registerCommand("pause", {
    description: "Pause provider requests until /continue is used.",
    handler: (args, ctx) => Promise.resolve(setPause(true, args, ctx)),
  });
  pi.registerCommand("continue", {
    description: "Continue provider requests paused by /pause.",
    handler: (args, ctx) => Promise.resolve(setPause(false, args, ctx)),
  });
  pi.on("before_provider_request", async (_event, ctx) => {
    await waitForPauseToEnd(agentDir, pause, ctx.signal);
  });
};
