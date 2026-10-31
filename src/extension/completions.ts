import type { RegisteredCommand } from "@earendil-works/pi-coding-agent";

/** pi's AutocompleteItem, taken from the command type so pi-tui stays an indirect dependency. */
export type AutocompleteItem = NonNullable<
  Awaited<ReturnType<NonNullable<RegisteredCommand["getArgumentCompletions"]>>>
>[number];

/** Completes a command argument from `values` by case-insensitive prefix, or `null` when nothing matches. */
export const completeFrom = (
  values: readonly string[],
  prefix: string
): AutocompleteItem[] | null => {
  const needle = prefix.trim().toLowerCase();

  const items = [...new Set(values)].flatMap((value) =>
    value.toLowerCase().startsWith(needle) ? [{ label: value, value }] : []
  );

  return items.length > 0 ? items : null;
};
