/**
 * Search's notes: the first page for the current filter through useOrderedQuery, then more pages appended as the list
 * scrolls. A new first page drops the appended ones.
 */
import type { NoteSummary, rpc } from "@overnote/core";
import { useCallback, useMemo, useState } from "react";
import type { Api } from "../bridge/api";
import { useOrderedQuery, type Settled } from "./useOrderedQuery";

const PAGE = 50;

export function useNoteBrowse(
  api: Api,
  /** The request key (filter plus anything that should refetch), or null while notes are not shown. */
  key: string | null,
  filter: string,
  onSettle: (result: Settled<rpc.ListResult>, latest: boolean) => void,
) {
  const first = useOrderedQuery(key, () => api.notes.browse({ filter: filter || undefined, limit: PAGE }), onSettle);
  // Pages appended to one first page; a new first page leaves them behind without an effect.
  const [more, setMore] = useState<{
    base: rpc.ListResult;
    items: NoteSummary[];
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
    api.notes.browse({ filter: filter || undefined, limit: PAGE, cursor }).then(
      (page) =>
        setMore((m) =>
          m?.base === base && m.cursor === cursor
            ? { base, items: [...m.items, ...page.items], cursor: page.nextCursor, loading: false }
            : m,
        ),
      () => setMore((m) => (m?.base === base ? { ...m, loading: false } : m)),
    );
  }, [api, base, extra, cursor, filter, loadingMore]);

  return { status: first.status, items, cursor, loadMore, pending: first.pending, retry: first.retry };
}
