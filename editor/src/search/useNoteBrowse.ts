/**
 * Search's notes: the first page for the current filter and sort through useOrderedQuery, then more pages appended as
 * the list scrolls. A new first page drops the appended ones.
 */
import type { BrowseItem, rpc, SearchSort } from "@overnote/core";
import { useCallback, useMemo, useState } from "react";
import type { Api } from "../bridge/api";
import { useOrderedQuery, type Settled } from "./useOrderedQuery";

const PAGE = 50;

const browseParams = (filter: string, sort: SearchSort, cursor?: string): rpc.BrowseParams => ({
  filter: filter || undefined,
  sort: { field: sort.field, direction: sort.direction },
  pinnedFirst: sort.pinnedFirst,
  limit: PAGE,
  cursor,
});

export function useNoteBrowse(
  api: Api,
  /** The request key (filter, sort, and anything else that should refetch), or null while notes are not shown. */
  key: string | null,
  filter: string,
  sort: SearchSort,
  onSettle: (result: Settled<rpc.BrowseResult>, latest: boolean) => void,
) {
  const first = useOrderedQuery(key, () => api.notes.browse(browseParams(filter, sort)), onSettle);
  // Pages appended to one first page; a new first page leaves them behind without an effect.
  const [more, setMore] = useState<{
    base: rpc.BrowseResult;
    items: BrowseItem[];
    cursor: string | null;
    loading: boolean;
  } | null>(null);
  const base = first.value;
  const extra = more && more.base === base ? more : null;
  const items = useMemo(() => [...(base?.items ?? []), ...(extra?.items ?? [])], [base, extra]);
  const cursor = extra ? extra.cursor : (base?.nextCursor ?? null);
  const loadingMore = extra?.loading ?? false;

  const loadMore = useCallback(() => {
    if (!base || !cursor || loadingMore) return;
    setMore({ base, items: extra?.items ?? [], cursor, loading: true });
    api.notes.browse(browseParams(filter, sort, cursor)).then(
      (page) =>
        setMore((m) =>
          m?.base === base && m.cursor === cursor
            ? { base, items: [...m.items, ...page.items], cursor: page.nextCursor, loading: false }
            : m,
        ),
      () => setMore((m) => (m?.base === base ? { ...m, loading: false } : m)),
    );
  }, [api, base, extra, cursor, filter, sort, loadingMore]);

  return { status: first.status, items, cursor, loadMore, pending: first.pending, retry: first.retry };
}
