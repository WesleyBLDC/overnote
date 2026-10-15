import { useCachedPromise } from "@raycast/utils";

import { listNotesPage } from "../api/notes";

/**
 * Notes matching the search text (title or body substring), or every note when it is empty,
 * loaded 100 at a time as the list scrolls.
 */
export function useSearch(query: string) {
  return useCachedPromise(
    (filter: string) =>
      async ({ cursor }: { cursor?: string }) => {
        const page = await listNotesPage(filter, cursor);
        return { data: page.items, hasMore: page.nextCursor !== null, cursor: page.nextCursor ?? undefined };
      },
    [query],
    { keepPreviousData: true },
  );
}
