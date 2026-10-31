import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { createModels } from "@earendil-works/pi-ai/models";
import type { Models } from "@earendil-works/pi-ai/models";

import { createCliproxyProvider } from "../../src/core/index.ts";
import type { ResolvedConnection } from "../../src/core/index.ts";
import { resolveExtensionConnection } from "../../src/extension/config.ts";

export const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
export const OUTPUT_DIR = path.join(PROJECT_ROOT, "test-output");
export const ISOLATED_AGENT_DIR = path.join(PROJECT_ROOT, ".tmp", "pi-agent");

/** The user's agent directory is read for credentials only, never written. */
const USER_AGENT_DIR = path.join(homedir(), ".pi", "agent");

export const FAMILY_MODELS = [
  "claude-haiku-5-5",
  "gpt-6-luna",
  "grok-4.7-build-fast",
  "kimi-k3.1-pro",
  "muse-spark-1.3",
] as const;

let cachedConnection: ResolvedConnection | undefined;

/** CLIPROXYAPI_* from the environment, then the user's stored login. */
export const liveConnection = (): ResolvedConnection => {
  cachedConnection ??=
    resolveExtensionConnection({
      agentDir: USER_AGENT_DIR,
      env: process.env,
      providerId: "cliproxyapi",
    }) ?? undefined;

  if (!cachedConnection) {
    throw new Error(
      "No CLIProxyAPI credentials. Set CLIPROXYAPI_BASE_URL and CLIPROXYAPI_API_KEY."
    );
  }

  return cachedConnection;
};

/** Env for child processes. The key travels only through the environment. */
export const liveEnv = (): NodeJS.ProcessEnv => {
  const connection = liveConnection();

  return {
    ...process.env,
    CLIPROXYAPI_API_KEY: connection.apiKey,
    CLIPROXYAPI_BASE_URL: connection.baseUrl,
  };
};

/** Replace the key anywhere in a string so saved output never holds it. */
export const redact = (text: string): string => {
  const { apiKey } = liveConnection();

  return text.split(apiKey).join("<redacted>");
};

export const saveOutput = async <Output extends CheckResult>(
  name: string,
  value: Output
): Promise<string> => {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `${name}.json`);
  await writeFile(file, redact(`${JSON.stringify(value, null, 2)}\n`), "utf-8");
  console.log(`saved ${path.relative(PROJECT_ROOT, file)}`);

  return file;
};

/** A pi-ai Models collection holding the core provider with the live catalog loaded. */
export const liveModels = async (
  extra: Partial<Parameters<typeof createCliproxyProvider>[0]> = {}
): Promise<Models> => {
  const connection = liveConnection();
  const models = createModels();
  models.setProvider(
    createCliproxyProvider({
      apiKey: connection.apiKey,
      baseUrl: connection.baseUrl,
      ...extra,
    })
  );

  const refreshed = await models.refresh({ providers: ["cliproxyapi"] });
  const error = refreshed.errors.get("cliproxyapi");

  if (error) {
    throw error;
  }

  return models;
};

export interface PiRun {
  args: string[];
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface PiRunOptions {
  /** A separate dir per run lets runs go in parallel and start from their own config and cache. */
  agentDir?: string;
  timeoutMs?: number;
}

/** Run pi isolated from the user's agent dir, with only this extension loaded. */
export const runPi = async (
  args: readonly string[],
  { agentDir = ISOLATED_AGENT_DIR, timeoutMs = 170_000 }: PiRunOptions = {}
): Promise<PiRun> => {
  await mkdir(agentDir, { recursive: true });

  const fullArgs = [
    "--no-extensions",
    "-e",
    "./src/extension/index.ts",
    "--no-session",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    ...args,
  ];

  const startedAt = Date.now();

  const child = spawn("pi", fullArgs, {
    cwd: PROJECT_ROOT,
    env: { ...liveEnv(), PI_CODING_AGENT_DIR: agentDir },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // SAFETY: Node emits close with the exit code, or null when a signal ended the child.
  const [exitCode] = (await once(child, "close")) as [number | null];

  return {
    args: fullArgs,
    durationMs: Date.now() - startedAt,
    exitCode,
    stderr: redact(stderr),
    stdout: redact(stdout),
  };
};

export interface CheckResult {
  check: string;
  pass: boolean;
  failures: string[];
}

/** Collect failures instead of stopping, so one run records every problem. */
export const createCheck = (check: string) => {
  const failures: string[] = [];

  return {
    expect(condition: boolean, message: string): void {
      if (!condition) {
        failures.push(message);
      }
    },
    finish(): CheckResult {
      const result = { check, failures, pass: failures.length === 0 };
      console.log(
        `${check}: ${result.pass ? "PASS" : "FAIL"}${failures.map((failure) => `\n  - ${failure}`).join("")}`
      );
      process.exitCode = result.pass ? 0 : 1;

      return result;
    },
  };
};
