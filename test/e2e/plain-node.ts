// Check 6: createCliproxyProvider runs from plain Node with only src/core and pi-ai,
// and no pi-coding-agent module is ever loaded. The child process holds the proof,
// because the parent reads credentials through the extension config, which uses pi-coding-agent.
import { execFile } from "node:child_process";
import { registerHooks } from "node:module";
import { promisify } from "node:util";

const CHILD_FLAG = "PLAIN_NODE_CHILD";
const PROMPT = "What is the capital of France? Answer with one word.";

const runChild = async (): Promise<void> => {
  const loaded = new Set<string>();
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const result = nextResolve(specifier, context);
      loaded.add(result.url);

      return result;
    },
  });

  const { createModels } = await import("@earendil-works/pi-ai/models");

  const { createCliproxyProvider, resolveConnection } =
    await import("../../src/core/index.ts");

  const connection = resolveConnection(process.env);

  if (!connection) {
    throw new Error("resolveConnection found no CLIPROXYAPI_* values");
  }

  const models = createModels();
  models.setProvider(
    createCliproxyProvider({
      apiKey: connection.apiKey,
      baseUrl: connection.baseUrl,
    })
  );
  const refreshed = await models.refresh({ providers: ["cliproxyapi"] });
  const model = models.getModel("cliproxyapi", "claude-haiku-5-5");

  if (!model) {
    throw new Error(
      `claude-haiku-5-5 is missing: ${String(refreshed.errors.get("cliproxyapi"))}`
    );
  }

  const reply = await models.completeSimple(model, {
    messages: [{ content: PROMPT, role: "user", timestamp: Date.now() }],
  });

  const answer = reply.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");

  process.stdout.write(
    JSON.stringify({
      answer,
      api: model.api,
      codingAgentModules: [...loaded].filter((url) =>
        url.includes("pi-coding-agent")
      ),
      loadedModuleCount: loaded.size,
      stopReason: reply.stopReason,
    })
  );
};

const runParent = async (): Promise<void> => {
  const { createCheck, liveEnv, redact, saveOutput } =
    await import("./live.ts");

  const check = createCheck("plain-node");

  const { stdout } = await promisify(execFile)(
    process.execPath,
    [import.meta.filename],
    { env: { ...liveEnv(), [CHILD_FLAG]: "1" }, timeout: 60_000 }
  );

  const child = JSON.parse(redact(stdout));

  check.expect(/paris/iu.test(child.answer), `answered "${child.answer}"`);
  check.expect(
    child.api === "anthropic-messages",
    `claude-haiku-5-5 used ${child.api}`
  );
  check.expect(
    child.loadedModuleCount > 0,
    "the resolve hook saw no modules, so the proof is empty"
  );
  check.expect(
    child.codingAgentModules.length === 0,
    `pi-coding-agent modules loaded: ${child.codingAgentModules.join(", ")}`
  );

  const result = check.finish();
  await saveOutput("plain-node", { ...result, child, prompt: PROMPT });
};

await (process.env[CHILD_FLAG] ? runChild() : runParent());
