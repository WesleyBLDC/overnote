import { describe, expect, it } from "vitest";

import { dateSection, groupIntoSections } from "../domain/sections";

// Local time, weeks start Monday. vitest.config.mts pins TZ to America/Los_Angeles, so the
// daylight saving case below is the real 23 hour day of 2026-03-08.
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();

describe("Search Notes date sections", () => {
  it("buckets by local day, a Monday week, and the calendar month", () => {
    const wednesday = new Date(at(2026, 10, 14, 9));
    expect(dateSection(at(2026, 10, 14, 0, 0), wednesday)).toBe("Today");
    expect(dateSection(at(2026, 10, 13, 23, 59), wednesday)).toBe("Yesterday");
    expect(dateSection(at(2026, 10, 12, 0, 0), wednesday)).toBe("This Week");
    expect(dateSection(at(2026, 10, 11, 23, 59), wednesday)).toBe("This Month");
    expect(dateSection(at(2026, 9, 30, 23, 59), wednesday)).toBe("Older");
  });

  it("on a Monday, Sunday is Yesterday and Saturday is already outside the week", () => {
    const monday = new Date(at(2026, 10, 19, 8));
    expect(dateSection(at(2026, 10, 18), monday)).toBe("Yesterday");
    expect(dateSection(at(2026, 10, 17), monday)).toBe("This Month");
  });

  it("on the first of the month, yesterday is the last day of the previous month", () => {
    const first = new Date(at(2026, 4, 1, 8));
    expect(dateSection(at(2026, 3, 31, 22), first)).toBe("Yesterday");
    expect(dateSection(at(2026, 3, 30, 22), first)).toBe("This Week");
    expect(dateSection(at(2026, 3, 29, 22), first)).toBe("Older");
  });

  it("the day after the spring daylight saving change still has a full Yesterday", () => {
    const afterChange = new Date(at(2026, 3, 9, 0, 30));
    expect(dateSection(at(2026, 3, 8, 0, 15), afterChange)).toBe("Yesterday");
    expect(dateSection(at(2026, 3, 8, 23, 45), afterChange)).toBe("Yesterday");
    // 2026-03-09 is a Monday, so the Saturday before is already outside the week.
    expect(dateSection(at(2026, 3, 7, 23, 45), afterChange)).toBe("This Month");
  });

  it("keeps pins first in pin order, the rest in incoming order, and drops empty sections", () => {
    const now = new Date(at(2026, 10, 14, 9));
    const notes = [
      { id: "p2", pinned: 2, updatedAt: at(2026, 1, 1) },
      { id: "t1", pinned: null, updatedAt: at(2026, 10, 14, 8) },
      { id: "o1", pinned: null, updatedAt: at(2025, 12, 1) },
      { id: "p1", pinned: 1, updatedAt: at(2026, 10, 14) },
      { id: "t2", pinned: null, updatedAt: at(2026, 10, 14, 7) },
    ];
    expect(groupIntoSections(notes, now).map((s) => [s.name, s.notes.map((n) => n.id)])).toEqual([
      ["Pinned", ["p2", "p1"]],
      ["Today", ["t1", "t2"]],
      ["Older", ["o1"]],
    ]);
  });
});
