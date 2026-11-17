/** Search's navigation machine: the transitions the keys rely on. Key handling end to end is in tests/search.spec.ts. */
import { describe, expect, it } from "vitest";
import { currentView, initialSearch, searchReducer, type SearchEvent, type SearchState } from "../src/search/state";

const run = (state: SearchState, ...events: SearchEvent[]) => events.reduce(searchReducer, state);

describe("searchReducer", () => {
  it("Escape leaves the submenu, then clears the query, then pops, then closes", () => {
    let s = run(initialSearch("root"), { type: "push", view: "deleted" }, { type: "type", query: "old" });
    s = run(s, { type: "escape" });
    expect([currentView(s), s.query, s.closed]).toEqual(["deleted", "", false]);
    s = run(s, { type: "escape" });
    expect([currentView(s), s.closed]).toEqual(["root", false]);
    s = run(s, { type: "enterSubmenu" }, { type: "escape" });
    expect([s.submenu.open, s.closed]).toEqual([false, false]);
    expect(run(s, { type: "escape" }).closed).toBe(true);
  });

  it("swaps notes and actions in place, so Escape still closes", () => {
    const s = run(initialSearch("browse"), { type: "type", query: "x" }, { type: "swap", view: "root" });
    expect([s.stack, s.query]).toEqual([["root"], ""]);
    expect(run(s, { type: "escape" }).closed).toBe(true);
  });

  it("only an answer to an empty search lands on the current note, and a pending open wins", () => {
    expect(run(initialSearch("browse"), { type: "answered", landOn: 2 }).index).toBe(2);
    expect(run(initialSearch("browse"), { type: "type", query: "a" }, { type: "answered", landOn: 2 }).index).toBe(0);
    const pending = run(initialSearch("browse"), { type: "openFirstWhenLoaded" }, { type: "answered", landOn: 2 });
    expect([pending.index, pending.openFirstWhenLoaded]).toEqual([0, false]);
  });

  it("moves wrap within the rows and within the submenu", () => {
    expect(run(initialSearch("root"), { type: "move", delta: -1, count: 3 }).index).toBe(2);
    const s = run(initialSearch("root"), { type: "enterSubmenu" }, { type: "moveInSubmenu", delta: -1, count: 4 });
    expect(s.submenu).toEqual({ open: true, index: 3 });
  });
});
