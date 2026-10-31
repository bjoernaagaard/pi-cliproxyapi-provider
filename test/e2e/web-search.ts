// Check 5: web search answers come from the final message item, with usage and cost,
// both from the library and through the registered web_search tool in a real pi run.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runWebSearch } from "../../src/web-search/index.ts";
import {
  PROJECT_ROOT,
  createCheck,
  liveConnection,
  liveModels,
  runPi,
  saveOutput,
} from "./live.ts";

// Muse stands in for the late-answer families. Kimi took 169 s per search on 2026-10-24.
const SEARCH_MODELS = ["gpt-6-luna", "muse-spark-1.3"];
const QUERY = "What is the latest stable Node.js release version?";

const check = createCheck("web-search");
const connection = liveConnection();
const models = await liveModels();

interface OutputItem {
  type?: string;
  content?: { type?: string; text?: string }[];
}

/** Keep a copy of the SSE body so the final output items can be compared with the answer. */
const teeFetch =
  (bodies: Promise<string>[]): typeof fetch =>
  async (input, init) => {
    const response = await fetch(input, init);
    const [mine, theirs] = response.body?.tee() ?? [null, null];

    if (mine) {
      bodies.push(new Response(mine).text());
    }

    return new Response(theirs, {
      headers: response.headers,
      status: response.status,
    });
  };

const completedOutput = (sse: string): OutputItem[] => {
  for (const line of sse.split("\n").toReversed()) {
    if (line.startsWith("data:") && line.includes('"response.completed"')) {
      return JSON.parse(line.slice(5)).response?.output ?? [];
    }
  }

  return [];
};

const itemText = (item: OutputItem): string =>
  item.type === "message"
    ? (item.content ?? [])
        .flatMap((part) => (part.text ? [part.text] : []))
        .join("")
    : "";

const searchWithLibrary = async (id: string) => {
  const model = models.getModel("cliproxyapi", id);

  if (!model) {
    check.expect(false, `${id} is missing from the catalog`);

    return { id, missing: true };
  }

  const bodies: Promise<string>[] = [];
  const startedAt = Date.now();

  const result = await runWebSearch({
    apiKey: connection.apiKey,
    fetchFn: teeFetch(bodies),
    model,
    query: QUERY,
    responsesUrl: connection.responsesUrl,
  });

  const sseBodies = await Promise.all(bodies);
  const output = completedOutput(sseBodies.join(""));

  const messageIndexes = output.flatMap((item, index) =>
    itemText(item).trim() ? [index] : []
  );

  const finalIndex = messageIndexes.at(-1);

  const finalText =
    finalIndex === undefined ? "" : itemText(output[finalIndex] ?? {}).trim();

  check.expect(result.answer.length > 0, `${id} returned no answer`);
  check.expect(
    result.answer === finalText,
    `${id} answer is not the final message item text`
  );
  check.expect(result.usage !== undefined, `${id} returned no usage`);
  check.expect(
    (result.usage?.cost.total ?? 0) > 0,
    `${id} usage cost is ${result.usage?.cost.total}`
  );

  return {
    answerPreview: result.answer.slice(0, 300),
    durationMs: Date.now() - startedAt,
    finalMessageIndex: finalIndex ?? null,
    id,
    messageItemIndexes: messageIndexes,
    outputItemTypes: output.map((item) => item.type),
    sourcesCount: result.sources.length,
    usage: result.usage,
  };
};

const library = await Promise.all(SEARCH_MODELS.map(searchWithLibrary));

/** The web_search tool result and the final assistant text from pi's JSON event stream. */
const readPiEvents = (stdout: string) => {
  const events = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));

  const end = events.find(
    (event) =>
      event.type === "tool_execution_end" && event.toolName === "web_search"
  );

  const final = events.findLast(
    (event) =>
      event.type === "message_end" && event.message?.role === "assistant"
  );

  const toolText = end?.result?.content?.[0]?.text ?? "";

  const finalText = (final?.message?.content ?? [])
    .flatMap((part: { type: string; text?: string }) =>
      part.type === "text" && part.text ? [part.text] : []
    )
    .join("");

  return { end, finalText, toolText };
};

// With nothing pinned, the tool must pick the cheapest priced GPT model.
const AUTO_SEARCH_MODEL = "gpt-6-luna";

// The pi tool path: the extension's web_search tool in each run's own agent dir.
// The automatic model runs unpinned, so the default choice is checked too.
const searchThroughPi = async (searchModel: string) => {
  const agentDir = path.join(
    PROJECT_ROOT,
    ".tmp",
    `pi-agent-search-${searchModel}`
  );

  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "cliproxyapi.json"),
    `${JSON.stringify(searchModel === AUTO_SEARCH_MODEL ? {} : { searchModel }, null, 2)}\n`
  );

  const run = await runPi(
    [
      "--mode",
      "json",
      "--model",
      "cliproxyapi/gpt-6-luna",
      "--tools",
      "web_search",
      `Call the web_search tool exactly once with the query "${QUERY}", then answer in one sentence.`,
    ],
    { agentDir, timeoutMs: 70_000 }
  );

  const { end, finalText, toolText } = readPiEvents(run.stdout);

  check.expect(
    run.exitCode === 0,
    `pi with ${searchModel} exited ${run.exitCode}: ${run.stderr.slice(-400)}`
  );
  check.expect(
    end !== undefined && !end.isError,
    `pi with ${searchModel} did not run web_search cleanly`
  );
  check.expect(
    end?.result?.details?.model === searchModel,
    `web_search used ${end?.result?.details?.model}, expected ${searchModel}`
  );
  check.expect(
    toolText.length > 0,
    `web_search via ${searchModel} returned no text`
  );
  check.expect(
    (end?.result?.usage?.cost?.total ?? 0) > 0,
    `web_search via ${searchModel} reported no usage cost in the tool result`
  );
  check.expect(
    finalText.length > 0,
    `pi with ${searchModel} gave no final answer`
  );

  return {
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    finalAnswer: finalText,
    searchModel,
    stderrTail: run.stderr.slice(-400),
    toolDetails: end?.result?.details,
    toolIsError: end?.isError,
    toolTextPreview: toolText.slice(0, 300),
    toolUsage: end?.result?.usage,
  };
};

const tool = await Promise.all(SEARCH_MODELS.map(searchThroughPi));

const result = check.finish();

await saveOutput("web-search", { ...result, library, query: QUERY, tool });
