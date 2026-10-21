/** Dropdown placement: every dropdown stays inside the panel, whatever its size. */
import { describe, expect, it } from "vitest";
import { placeDropdown } from "../src/lib/placement";

// A 405 x 197 panel with 10 points kept clear on each side and the 12 point drag strip on top.
const bounds = { top: 16, bottom: 187, left: 10, right: 395 };
const below = { prefer: "below", gap: 4, align: "start" } as const;

describe("placeDropdown", () => {
  it("drops below the anchor when it fits, and flips above when only that side fits", () => {
    expect(
      placeDropdown({ top: 40, bottom: 60, left: 30, right: 30 }, { width: 200, height: 100 }, bounds, below),
    ).toMatchObject({ side: "below", top: 64, left: 30, maxHeight: 123 });
    expect(
      placeDropdown({ top: 150, bottom: 170, left: 30, right: 30 }, { width: 200, height: 100 }, bounds, below),
    ).toMatchObject({ side: "above", top: 46, maxHeight: 130 });
  });

  it("takes the roomier side when neither fits, capped to that room so it scrolls inside", () => {
    const tall = { width: 200, height: 400 };
    const low = placeDropdown({ top: 120, bottom: 140, left: 30, right: 30 }, tall, bounds, below);
    expect(low).toMatchObject({ side: "above", maxHeight: 100 });
    expect(low.top).toBe(bounds.top);
    const high = placeDropdown({ top: 60, bottom: 80, left: 30, right: 30 }, tall, bounds, below);
    expect(high).toMatchObject({ side: "below", top: 84, maxHeight: 103 });
    expect(high.top + high.maxHeight).toBe(bounds.bottom);
  });

  it("slides sideways to stay inside, and centers on the anchor when asked", () => {
    const anchor = { top: 150, bottom: 170, left: 20, right: 50 };
    const menu = { width: 210, height: 90 };
    expect(placeDropdown(anchor, menu, bounds, { ...below, align: "center" }).left).toBe(10);
    expect(placeDropdown({ ...anchor, left: 380, right: 390 }, menu, bounds, below).left).toBe(185);
    expect(placeDropdown({ ...anchor, left: 180, right: 220 }, menu, bounds, { ...below, align: "center" }).left).toBe(
      95,
    );
    const wide = placeDropdown(anchor, { width: 500, height: 90 }, bounds, below);
    expect(wide).toMatchObject({ left: 10, maxWidth: 385 });
  });
});
