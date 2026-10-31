import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  pollOAuthStatus,
  startOAuth,
  submitOAuthCallback,
} from "../core/index.ts";
import { completeFrom } from "./completions.ts";
import { MANAGEMENT_KEY_ENV } from "./usage.ts";
import type { UsageTracker } from "./usage.ts";

export interface RegisterOAuthLoginOptions {
  providerId: string;
  tracker: UsageTracker;
  /** Refreshes the model catalog the way /cliproxyapi-refresh does. */
  refresh: (ctx: ExtensionContext) => Promise<void>;
}

/** Built-in CLIProxyAPI login providers. Plugins can add more ids. */
const LOGIN_PROVIDERS = [
  "claude",
  "codex",
  "antigravity",
  "kimi",
  "kimi-ai",
  "xai",
  "devin",
  "meta",
] as const;

const KNOWN_PROVIDERS = `${LOGIN_PROVIDERS.join(", ")}, or a plugin provider id`;

const PROVIDER_WITH_SPACE = /\s/u;

/** The provider argument, or a picked one when bare with a UI. `undefined` means the picker was cancelled. */
const chooseProvider = async (
  args: string,
  ctx: ExtensionContext
): Promise<string | undefined> => {
  const provider = args.trim();

  if (provider || !ctx.hasUI) {
    return provider;
  }

  return await ctx.ui.select("CLIProxyAPI account provider", [
    ...LOGIN_PROVIDERS,
  ]);
};

/**
 * Registers /cliproxyapi-login <provider>: starts an upstream account login
 * on the CLIProxyAPI server, asks for the browser's redirect URL, submits
 * it, and waits for the server to finish the credential exchange.
 */
export const registerOAuthLogin = (
  pi: ExtensionAPI,
  options: RegisterOAuthLoginOptions
): void => {
  pi.registerCommand("cliproxyapi-login", {
    description: `Add an upstream account to CLIProxyAPI (/cliproxyapi-login <provider>: ${KNOWN_PROVIDERS}).`,
    getArgumentCompletions: (prefix) => completeFrom(LOGIN_PROVIDERS, prefix),
    handler: async (args, ctx) => {
      // Check the setup first, so the picker never opens for a login that cannot run.
      if (!options.tracker.hasManagementKey()) {
        ctx.ui.notify(
          `CLIProxyAPI management key is not set. Set ${MANAGEMENT_KEY_ENV} or add "managementKey" to cliproxyapi.json, then run /cliproxyapi-login again.`,
          "error"
        );

        return;
      }

      const access = options.tracker.managementAccess();

      if (!access) {
        ctx.ui.notify(
          `CLIProxyAPI is not configured. Run /login ${options.providerId} first.`,
          "error"
        );

        return;
      }

      const provider = await chooseProvider(args, ctx);

      if (provider === undefined) {
        return;
      }

      if (!provider || PROVIDER_WITH_SPACE.test(provider)) {
        ctx.ui.notify(
          `Usage: /cliproxyapi-login <provider> (${KNOWN_PROVIDERS})`,
          "error"
        );

        return;
      }

      const { baseUrl, managementKey } = access;
      const { signal } = ctx;

      try {
        const start = await startOAuth({
          baseUrl,
          managementKey,
          provider,
          signal,
        });

        ctx.ui.notify(
          `Open this URL in a browser to sign in to ${provider}:\n${start.url}`,
          "info"
        );

        if (start.flow === "device") {
          // Device logins (Kimi, xAI, Meta) never redirect back: the server
          // polls the provider itself, so only the status needs polling.
          if (start.userCode) {
            ctx.ui.notify(`Enter this code: ${start.userCode}`, "info");
          }
        } else {
          const redirectUrl = await ctx.ui.input(
            `Paste the full redirect URL for ${provider}`,
            "http://127.0.0.1/callback?code=...&state=...",
            signal ? { signal } : undefined
          );

          if (!redirectUrl?.trim()) {
            ctx.ui.notify(
              `CLIProxyAPI login for ${provider} was cancelled.`,
              "warning"
            );

            return;
          }

          await submitOAuthCallback({
            baseUrl,
            managementKey,
            provider,
            redirectUrl: redirectUrl.trim(),
            signal,
          });
        }

        ctx.ui.notify(
          `Completing the ${provider} login with CLIProxyAPI...`,
          "info"
        );

        const result = await pollOAuthStatus({
          baseUrl,
          managementKey,
          signal,
          state: start.state,
        });

        if (result.status !== "ok") {
          ctx.ui.notify(
            `CLIProxyAPI login for ${provider} failed: ${result.error ?? "the server reported an error"}`,
            "error"
          );

          return;
        }

        try {
          await options.refresh(ctx);
        } catch (error) {
          ctx.ui.notify(
            `Added the ${provider} account to CLIProxyAPI, but refreshing models failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning"
          );

          return;
        }

        ctx.ui.notify(
          `Added the ${provider} account to CLIProxyAPI and refreshed the model catalog.`,
          "info"
        );
      } catch (error) {
        if (signal?.aborted) {
          ctx.ui.notify(
            `CLIProxyAPI login for ${provider} was cancelled.`,
            "warning"
          );

          return;
        }

        ctx.ui.notify(
          `CLIProxyAPI login for ${provider} failed: ${error instanceof Error ? error.message : String(error)}`,
          "error"
        );
      }
    },
  });
};
