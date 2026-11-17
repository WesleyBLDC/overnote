/**
 * One async request per key, applied in request order: an answer that arrives after a newer one is dropped, but every
 * request so far still applies as soon as it answers, so a list narrows while you type. The last value stays shown
 * through a reload or a failure. `latest` tells the caller which answer belongs to the newest key, the only one that
 * may act (open a note, move the selection).
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type QueryStatus = "loading" | "loaded" | "error";

export interface OrderedQuery<T> {
  status: QueryStatus;
  value: T | undefined;
  /** The newest key has not answered yet: what shows belongs to an older request. Read at event time. */
  pending: () => boolean;
  retry: () => void;
}

export type Settled<T> = { ok: true; value: T } | { ok: false };

/**
 * `key` null means idle (nothing requested). `onSettle` runs for every applied answer or failure, with `latest` set
 * when it settles the newest key. One request per key: StrictMode's second effect run in development would otherwise ask
 * twice, and a failed answer could hide behind the repeat's success.
 */
export function useOrderedQuery<T>(
  key: string | null,
  run: () => Promise<T>,
  onSettle?: (result: Settled<T>, latest: boolean) => void,
): OrderedQuery<T> {
  const [state, setState] = useState<{ status: QueryStatus; value: T | undefined }>({
    status: "loading",
    value: undefined,
  });
  const [attempt, setAttempt] = useState(0);
  const requested = useRef(0);
  const applied = useRef(0);
  const lastKey = useRef<string | null>(null);
  const latest = useRef({ run, onSettle });
  useEffect(() => {
    latest.current = { run, onSettle };
  });

  useEffect(() => {
    if (key === null) {
      lastKey.current = null;
      return;
    }
    const full = `${key}#${attempt}`;
    if (lastKey.current === full) return;
    lastKey.current = full;
    const request = ++requested.current;
    latest.current.run().then(
      (value) => {
        if (request < applied.current) return;
        applied.current = request;
        setState({ status: "loaded", value });
        latest.current.onSettle?.({ ok: true, value }, request === requested.current);
      },
      () => {
        if (request < applied.current) return;
        applied.current = request;
        setState((s) => ({ ...s, status: "error" }));
        latest.current.onSettle?.({ ok: false }, request === requested.current);
      },
    );
  }, [key, attempt]);

  const retry = useCallback(() => {
    setState((s) => ({ ...s, status: "loading" }));
    setAttempt((n) => n + 1);
  }, []);

  const pending = useCallback(() => applied.current < requested.current, []);
  return { ...state, pending, retry };
}
