/**
 * Search's navigation state (board 07, SPEC §7) as one explicit machine: which view shows, what is typed, which row
 * is selected, whether the submenu on the right has the selection, a pending "open the first note" intent, and
 * whether Search has closed. Every key and pointer move is an event; the reducer is pure, so it is unit tested.
 */
import type { PanelViewName } from "../ui/CommandPanel";

export interface SearchState {
  /** The view stack: the last one shows; Escape pops it, and popping the last closes Search. */
  stack: PanelViewName[];
  query: string;
  index: number;
  /** In All actions, → moves the selection into the highlighted submenu. */
  submenu: { open: boolean; index: number };
  /** Enter pressed while the list still showed an older search: open the first note once the latest answers. */
  openFirstWhenLoaded: boolean;
  closed: boolean;
}

export type SearchEvent =
  | { type: "type"; query: string }
  | { type: "select"; index: number }
  | { type: "move"; delta: number; count: number }
  | { type: "enterSubmenu" }
  | { type: "leaveSubmenu" }
  | { type: "selectInSubmenu"; index: number }
  | { type: "moveInSubmenu"; delta: number; count: number }
  | { type: "push"; view: PanelViewName }
  /** Notes and All actions swap in place (">" and Backspace on the token), so Escape still closes. */
  | { type: "swap"; view: "browse" | "root" }
  | { type: "escape" }
  | { type: "close" }
  | { type: "openFirstWhenLoaded" }
  /** The latest search answered: settle a pending open, or (with nothing typed) land on `landOn`. */
  | { type: "answered"; landOn: number | null };

export function initialSearch(view: PanelViewName): SearchState {
  return {
    stack: [view],
    query: "",
    index: 0,
    submenu: { open: false, index: 0 },
    openFirstWhenLoaded: false,
    closed: false,
  };
}

export const currentView = (state: SearchState): PanelViewName => state.stack[state.stack.length - 1] ?? "root";

const wrap = (index: number, delta: number, count: number) => (count ? (index + delta + count) % count : 0);

/** A fresh view or query starts at the top with the submenu closed. */
const fresh = (state: SearchState, patch: Partial<SearchState>): SearchState => ({
  ...state,
  query: "",
  index: 0,
  submenu: { open: false, index: 0 },
  openFirstWhenLoaded: false,
  ...patch,
});

export function searchReducer(state: SearchState, event: SearchEvent): SearchState {
  switch (event.type) {
    case "type":
      return { ...state, query: event.query, index: 0, submenu: { open: false, index: 0 }, openFirstWhenLoaded: false };
    case "select":
      return { ...state, index: event.index, submenu: { ...state.submenu, open: false } };
    case "move":
      return { ...state, index: wrap(Math.min(state.index, Math.max(0, event.count - 1)), event.delta, event.count) };
    case "enterSubmenu":
      return { ...state, submenu: { open: true, index: 0 } };
    case "leaveSubmenu":
      return { ...state, submenu: { ...state.submenu, open: false } };
    case "selectInSubmenu":
      return { ...state, submenu: { open: true, index: event.index } };
    case "moveInSubmenu":
      return { ...state, submenu: { open: true, index: wrap(state.submenu.index, event.delta, event.count) } };
    case "push":
      return fresh(state, { stack: [...state.stack, event.view] });
    case "swap":
      return fresh(state, { stack: [...state.stack.slice(0, -1), event.view] });
    case "escape":
      if (state.submenu.open) return { ...state, submenu: { ...state.submenu, open: false } };
      if (state.query) return fresh(state, {});
      return state.stack.length > 1 ? fresh(state, { stack: state.stack.slice(0, -1) }) : { ...state, closed: true };
    case "close":
      return { ...state, closed: true };
    case "openFirstWhenLoaded":
      return { ...state, openFirstWhenLoaded: true };
    case "answered":
      if (state.openFirstWhenLoaded) return { ...state, openFirstWhenLoaded: false };
      return event.landOn === null || state.query.trim() ? state : { ...state, index: event.landOn };
  }
}
