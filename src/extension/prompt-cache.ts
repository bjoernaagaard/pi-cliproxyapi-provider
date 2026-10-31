import type { ModelPromptCache } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const LIFETIMES = new Map<string, ModelPromptCache | undefined>(
  getBuiltinModels("anthropic").map((model) => [model.id, model.promptCache])
);

/** pi-ai's own Anthropic lifetimes, matched on the id or its segment after the last "/". */
export const anthropicPromptCache = (
  id: string
): ModelPromptCache | undefined => {
  const modelId = id.trim().toLowerCase();
  const segment = modelId.slice(modelId.lastIndexOf("/") + 1);
  const lifetimes = LIFETIMES.get(modelId) ?? LIFETIMES.get(segment);

  return lifetimes ? { ...lifetimes } : undefined;
};
