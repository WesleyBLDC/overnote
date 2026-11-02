import { describe, expect, it } from "vitest";

import { daysUntilPermanentRemoval, pinnedLabel, pinPositions, searchSnippet, wordCount } from "../domain/format";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("note display shaping", () => {
  it("places pinned notes in incoming pin order and labels only the first nine with a shortcut", () => {
    const notes: { id: string; pinned: number | null }[] = Array.from({ length: 11 }, (_, index) => ({
      id: `p${index + 1}`,
      pinned: (index + 1) * 1000,
    }));
    notes.push({ id: "plain", pinned: null });
    const positions = pinPositions(notes);
    expect(positions.get("p1")).toEqual({ index: 1, total: 11, isFirst: true, isLast: false });
    expect(positions.get("p11")).toEqual({ index: 11, total: 11, isFirst: false, isLast: true });
    expect(positions.has("plain")).toBe(false);
    expect(pinnedLabel(notes[1]!, positions.get("p2"))).toBe("Pinned 2 of 11 (⌘2)");
    expect(pinnedLabel(notes[9]!, positions.get("p10"))).toBe("Pinned 10 of 11");
    expect(pinnedLabel({ pinned: null })).toBe("Not pinned");
  });

  it("shows context around a folded match and falls back when only the title matches", () => {
    const note = {
      title: "Café plan",
      preview: "Café plan\nThe agenda covers pricing, hiring, and the launch checklist for next week.",
    };
    expect(searchSnippet(note, "cafe")).toBeUndefined();
    expect(searchSnippet(note, "launch")).toContain("launch checklist");
    expect(searchSnippet(note, "missing")).toBeUndefined();
    expect(
      searchSnippet({ title: "T", preview: `T\n${"word ".repeat(30)}needle${" word".repeat(30)}` }, "needle"),
    ).toMatch(/^….*needle.*…$/);
  });

  it("counts whole days left in Recently Deleted, rounding up and stopping at zero", () => {
    const deletedAt = 1_000_000_000_000;
    expect(daysUntilPermanentRemoval(deletedAt, deletedAt)).toBe(60);
    expect(daysUntilPermanentRemoval(deletedAt, deletedAt + 59 * DAY_MS + 1)).toBe(1);
    expect(daysUntilPermanentRemoval(deletedAt, deletedAt + 61 * DAY_MS)).toBe(0);
  });

  it("formats word counts", () => {
    expect(wordCount(1)).toBe("1 word");
    expect(wordCount(1200)).toBe("1,200 words");
  });
});
