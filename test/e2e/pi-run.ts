// Check 7: a real pi print run answers with one model per family, each starting
// from an empty agent dir, as a fresh install or headless app does. Pi always
// sends a system prompt, which bare pi-ai checks don't.
import { rm } from "node:fs/promises";
import path from "node:path";

import {
  FAMILY_MODELS,
  PROJECT_ROOT,
  createCheck,
  runPi,
  saveOutput,
} from "./live.ts";

const PROMPT = "What is the capital of France? Answer with one word.";

const check = createCheck("pi-run");

const coldRun = async (id: string) => {
  const agentDir = path.join(PROJECT_ROOT, ".tmp", `pi-agent-cold-${id}`);
  await rm(agentDir, { force: true, recursive: true });

  const run = await runPi(["--model", `cliproxyapi/${id}`, "-p", PROMPT], {
    agentDir,
    timeoutMs: 60_000,
  });

  const answer = run.stdout.trim();

  check.expect(
    run.exitCode === 0,
    `${id} exited ${run.exitCode}: ${run.stderr.slice(-400)}`
  );
  check.expect(/paris/iu.test(answer), `${id} answered "${answer}"`);

  return {
    answer,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    id,
    stderrTail: run.stderr.slice(-400),
  };
};

const runs = await Promise.all(FAMILY_MODELS.map(coldRun));
const result = check.finish();

await saveOutput("pi-run", { ...result, prompt: PROMPT, runs });
