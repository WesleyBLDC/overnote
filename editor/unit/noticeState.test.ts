/** The notices lifecycle. Timing and the fade end to end are in tests/window.spec.ts and tests/autosave.spec.ts. */
import { describe, expect, it } from "vitest";
import { noticesReducer, type Notice, type NoticeEvent } from "../src/ui/noticeState";

const run = (state: Notice[], ...events: NoticeEvent[]) => events.reduce(noticesReducer, state);
const add = (id: number): NoticeEvent => ({ type: "add", id, message: `n${id}`, kind: "info" });

describe("noticesReducer", () => {
  it("adds, expires, then removes a notice", () => {
    const shown = run([], add(1));
    expect(shown).toEqual([{ id: 1, message: "n1", kind: "info", leaving: false }]);
    const leaving = run(shown, { type: "expire", id: 1 });
    expect(leaving[0]?.leaving).toBe(true);
    expect(run(leaving, { type: "remove", id: 1 })).toEqual([]);
  });

  it("keeps the newest three", () => {
    expect(run([], add(1), add(2), add(3), add(4)).map((notice) => notice.id)).toEqual([2, 3, 4]);
  });

  it("a double dismiss or a late removal returns the same list, so nothing re-renders", () => {
    const leaving = run([], add(1), { type: "expire", id: 1 });
    expect(run(leaving, { type: "expire", id: 1 })).toBe(leaving);
    const gone = run(leaving, { type: "remove", id: 1 });
    expect(run(gone, { type: "remove", id: 1 }, { type: "expire", id: 1 })).toBe(gone);
  });
});
