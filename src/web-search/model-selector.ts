const searchModelRank = (modelId: string): number => {
  const normalized = modelId.trim().toLowerCase();

  const isGpt =
    /(?:^|[^a-z0-9])gpt(?:[^a-z0-9]|$)/u.test(normalized) ||
    normalized.startsWith("gpt");

  const isClaude = normalized.includes("claude");

  if (isGpt && normalized.includes("fast")) {
    return 0;
  }

  if (isGpt) {
    return 1;
  }

  if (isClaude && normalized.includes("haiku")) {
    return 2;
  }

  if (isClaude) {
    return 3;
  }

  return 4;
};

/** A pi-ai Model fits this shape. */
export interface SearchCandidate {
  id: string;
  cost?: { input: number };
  supportsWebSearch?: boolean;
}

/** Zero means pricing is unknown, so it sorts after every priced model. */
const inputPrice = (candidate: SearchCandidate): number => {
  const input = candidate.cost?.input ?? 0;

  return input > 0 ? input : Number.POSITIVE_INFINITY;
};

/**
 * Pick a search model. Models known not to support web search are excluded.
 * The preferred id wins when it is present and not excluded. Otherwise
 * models known to support web search come before models with unknown
 * support. Within each support group, fast GPT models come first, then
 * other GPT models, then Claude Haiku models, then other Claude models,
 * then everything else. Within a group the cheapest priced model wins,
 * and catalog order breaks ties.
 */
export const selectSearchModel = (
  models: readonly SearchCandidate[],
  preferred?: string
): string | undefined => {
  const candidates = models.filter(
    (model) => model.id.trim().length > 0 && model.supportsWebSearch !== false
  );

  if (candidates.length === 0) {
    return undefined;
  }

  if (preferred?.trim()) {
    const wanted = preferred.trim().toLowerCase();

    const match = candidates.find(
      (model) => model.id.trim().toLowerCase() === wanted
    );

    if (match) {
      return match.id;
    }
  }

  const ranked = candidates
    .map((model, index) => ({
      index,
      modelId: model.id,
      price: inputPrice(model),
      rank: searchModelRank(model.id),
      supportGroup: model.supportsWebSearch === true ? 0 : 1,
    }))
    .toSorted(
      (a, b) =>
        a.supportGroup - b.supportGroup ||
        a.rank - b.rank ||
        (a.price === b.price ? 0 : a.price - b.price) ||
        a.index - b.index
    );

  return ranked[0]?.modelId;
};
