/**
 * The notices (toasts) as one explicit lifecycle: a notice is added, expires (marked as leaving, so the
 * stylesheet fades it out), and is removed. The reducer is pure and returns the same list when an event
 * changes nothing, so a repeated dismiss or a late timer never re-renders; useNotices owns the timers.
 */
import type { NoticeAction, NoticeKind } from "../lib/notice";

export interface Notice {
  id: number;
  message: string;
  kind: NoticeKind;
  action?: NoticeAction;
  /** Set when the notice's time is up: the stylesheet fades it out, then it is removed. */
  leaving: boolean;
}

/** Toasts show one at a time (SPEC §11): a new one replaces the one showing. */
export const MAX_NOTICES = 1;

export type NoticeEvent =
  | { type: "add"; id: number; message: string; kind: NoticeKind; action?: NoticeAction }
  /** Its time is up or it was dismissed: start the exit fade. */
  | { type: "expire"; id: number }
  /** The exit fade ended, or its fallback timer fired. */
  | { type: "remove"; id: number };

export function noticesReducer(state: Notice[], event: NoticeEvent): Notice[] {
  switch (event.type) {
    case "add": {
      const { id, message, kind, action } = event;
      return [...state.slice(state.length - MAX_NOTICES + 1), { id, message, kind, action, leaving: false }];
    }
    case "expire":
      if (!state.some((notice) => notice.id === event.id && !notice.leaving)) return state;
      return state.map((notice) => (notice.id === event.id ? { ...notice, leaving: true } : notice));
    case "remove":
      return state.some((notice) => notice.id === event.id) ? state.filter((notice) => notice.id !== event.id) : state;
  }
}
