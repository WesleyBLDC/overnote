/** The corner count's short form (SPEC §5): never wider than 5 characters. */
import { describe, expect, it } from "vitest";
import { formatCount } from "../src/lib/count";

describe("formatCount", () => {
  it("caps the count at 5 characters with k and M", () => {
    const cases: [number, string][] = [
      [7, "7"],
      [9_999, "9,999"],
      [10_000, "10k"],
      [12_400, "12.4k"],
      [99_949, "99.9k"],
      [128_000, "128k"],
      [120_000, "120k"],
      [1_200_000, "1.2M"],
    ];
    for (const [n, shown] of cases) {
      expect(formatCount(n)).toBe(shown);
      expect(formatCount(n).length).toBeLessThanOrEqual(5);
    }
  });
});
