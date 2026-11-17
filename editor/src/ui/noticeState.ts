/**
 * The notices (toasts) as one explicit lifecycle: a notice is added, expires (marked as leaving, so the
 * stylesheet fades it out), and is removed. The reducer is pure and returns the same list when an event
 * changes nothing, so a repeated dismiss or a late timer never re-renders; useNotices owns the timers.
 */
export type NoticeKind = "info" | "error";

export interface Notice {
  id: number;
  message: string;
  kind: NoticeKind;
  /** Set when the notice's time is up: the stylesheet fades it out, then it is removed. */
  leaving: boolean;
}

/** How many notices show at once; a new one pushes out the oldest. */
export const MAX_NOTICES = 3;

export type NoticeEvent =
  | { type: "add"; id: number; message: string; kind: NoticeKind }
  /** Its time is up or it was dismissed: start the exit fade. */
  | { type: "expire"; id: number }
  /** The exit fade ended, or its fallback timer fired. */
  | { type: "remove"; id: number };

export function noticesReducer(state: Notice[], event: NoticeEvent): Notice[] {
  switch (event.type) {
    case "add": {
      const { id, message, kind } = event;
      return [...state.slice(1 - MAX_NOTICES), { id, message, kind, leaving: false }];
    }
    case "expire":
      if (!state.some((notice) => notice.id === event.id && !notice.leaving)) return state;
      return state.map((notice) => (notice.id === event.id ? { ...notice, leaving: true } : notice));
    case "remove":
      return state.some((notice) => notice.id === event.id) ? state.filter((notice) => notice.id !== event.id) : state;
  }
}
