/**
 * The terminal drawer's visibility and height as one explicit machine. Opening asks the panel to grow (`growing`)
 * and shows the drawer once that frame has landed (`shown`); closing hides it at once (`closed`) and then shrinks
 * the panel. Every open and close starts a new `seq`, so the continuation of an older call, such as a grow that
 * lands after the drawer was closed and opened again, sees that it is stale and changes nothing.
 */

export type DrawerPhase = "closed" | "growing" | "shown";

export interface DrawerState {
  phase: DrawerPhase;
  /** Bumped by every open and close: the current call's token. */
  seq: number;
  /** The height last sent to the panel (window.setDrawer), 0 when it has none. */
  height: number;
}

export type DrawerEvent =
  | { type: "open" }
  | { type: "close" }
  /** The panel grew for the open call `seq`. */
  | { type: "grown"; seq: number }
  /** The height sent to the panel. */
  | { type: "height"; height: number };

export const initialDrawer: DrawerState = { phase: "closed", seq: 0, height: 0 };

export function drawerReducer(state: DrawerState, event: DrawerEvent): DrawerState {
  switch (event.type) {
    case "open":
      // Opening an open drawer only takes a new token, so the drawer never blinks.
      return { ...state, phase: state.phase === "closed" ? "growing" : state.phase, seq: state.seq + 1 };
    case "close":
      return { ...state, phase: "closed", seq: state.seq + 1 };
    case "grown":
      return state.phase === "growing" && event.seq === state.seq ? { ...state, phase: "shown" } : state;
    case "height":
      return event.height === state.height ? state : { ...state, height: event.height };
  }
}
