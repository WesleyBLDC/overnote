/** History stack math: the one editor rule worth a unit test. */
import { describe, expect, it } from "vitest";
import { NoteHistory } from "../src/session/history";

describe("NoteHistory", () => {
  it("goes back and forward like a browser, skipping the current note", () => {
    const history = new NoteHistory();
    history.visit("A");
    history.visit("B");
    history.visit("B");
    expect(history.commitBack("C")).toBe("B");
    expect(history.commitBack("B")).toBe("A");
    expect(history.commitForward("A")).toBe("B");
    history.visit("B");
    expect(history.peekForward("D")).toBeNull();
  });

  it("caps each stack and forgets deleted notes", () => {
    const history = new NoteHistory(100);
    for (let i = 0; i < 150; i++) history.visit(`n${i}`);
    expect(history.snapshot().back).toHaveLength(100);
    history.remove("n149");
    expect(history.peekBack("x")).toBe("n148");
  });
});
