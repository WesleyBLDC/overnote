/**
 * The folding rule for filter matching (contract v2): NFKD, strip combining marks, lowercase.
 * The helper stores `title_fold` and `text_fold` with the same rule.
 */
export function foldForMatch(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** A `LIKE` pattern that matches `query` as a literal substring, for use with `ESCAPE '\'`. */
export function likeSubstringPattern(query: string): string {
  return `%${foldForMatch(query).replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Normalizes a search string: trimmed, and empty or whitespace means no filter. */
export function normalizeFilter(filter: string | null | undefined): string | undefined {
  const trimmed = filter?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Moves notes whose display title contains the query to the front, keeping the original order
 * inside each group (the client side reorder Search Notes applies to each page).
 */
export function titleMatchesFirst<T>(items: T[], filter: string | undefined, titleOf: (item: T) => string): T[] {
  const query = normalizeFilter(filter);
  if (!query) return items;
  const needle = foldForMatch(query);
  const hits: T[] = [];
  const rest: T[] = [];
  for (const item of items) (foldForMatch(titleOf(item)).includes(needle) ? hits : rest).push(item);
  return [...hits, ...rest];
}
