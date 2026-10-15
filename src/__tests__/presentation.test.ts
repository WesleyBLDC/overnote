import { describe, expect, it } from "vitest";

import { noteDeeplink } from "../domain/deeplink";
import { characterCount, displayTitle, escapeNonAscii, previewWithoutTitle, summaryTitle } from "../domain/format";
import { dateSection, groupIntoSections } from "../domain/sections";

describe("titles and previews", () => {
  it("falls back from title to the first text line to Untitled", () => {
    expect(displayTitle({ title: "  Title  ", text: "ignored" })).toBe("Title");
    expect(displayTitle({ title: "", text: " First line \nSecond" })).toBe("First line");
    expect(summaryTitle({ title: "", preview: "" })).toBe("Untitled");
  });

  it("drops the title line from the preview", () => {
    expect(previewWithoutTitle({ title: "Groceries", preview: "Groceries\nmilk\n  eggs" })).toBe("milk eggs");
  });

  it("formats character counts", () => {
    expect(characterCount(1)).toBe("1 character");
    expect(characterCount(1234)).toBe("1,234 characters");
  });

  it("escapes non-ASCII as entities for the HTML flavor", () => {
    expect(escapeNonAscii("<p>Café 😀</p>")).toBe("<p>Caf&#233; &#128512;</p>");
  });
});

describe("deeplinks", () => {
  it("opens a note through toggle-notes with a JSON context", () => {
    const link = noteDeeplink("01HXYZ");
    expect(link).toBe(
      "raycast://extensions/wesleybldc/better-notes/toggle-notes?context=%7B%22id%22%3A%2201HXYZ%22%7D",
    );
    expect(JSON.parse(decodeURIComponent(new URL(link).searchParams.get("context") ?? ""))).toEqual({ id: "01HXYZ" });
  });
});

describe("Search Notes sections", () => {
  // Wednesday 2026-10-14 15:00 local time.
  const now = new Date(2026, 9, 14, 15, 0, 0);
  const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();

  it("buckets by last edit with weeks starting Monday", () => {
    expect(dateSection(at(14, 0), now)).toBe("Today");
    expect(dateSection(at(13, 23), now)).toBe("Yesterday");
    expect(dateSection(at(12), now)).toBe("This Week");
    expect(dateSection(at(11), now)).toBe("This Month");
    expect(dateSection(at(1), now)).toBe("This Month");
    expect(dateSection(new Date(2026, 8, 30).getTime(), now)).toBe("Older");
  });

  it("keeps pinned notes first in pin order and drops empty sections", () => {
    const notes = [
      { id: "p1", pinned: 1000, updatedAt: at(1) },
      { id: "p2", pinned: 2000, updatedAt: at(14) },
      { id: "t", pinned: null, updatedAt: at(14) },
      { id: "o", pinned: null, updatedAt: new Date(2025, 0, 1).getTime() },
    ];
    const sections = groupIntoSections(notes, now);
    expect(sections.map((section) => [section.name, section.notes.map((note) => note.id)])).toEqual([
      ["Pinned", ["p1", "p2"]],
      ["Today", ["t"]],
      ["Older", ["o"]],
    ]);
  });
});
