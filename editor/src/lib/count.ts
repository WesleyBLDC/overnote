/** Word and character counts: the full labels, and the short form the corner shows (SPEC §5). */
import type { CountMode } from "@overnote/core";

const grouped = (n: number) => n.toLocaleString("en-US");

/**
 * The corner's count, never wider than 5 characters: 0 to 9,999 as is, then 12.4k, 128k, and 1.2M.
 * The full value is always in the label (countLabel), shown on hover.
 */
export function formatCount(n: number): string {
  if (n < 10_000) return grouped(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
}

export function characterLabel(n: number): string {
  return `${grouped(n)} ${n === 1 ? "character" : "characters"}`;
}

export function wordLabel(n: number): string {
  return `${grouped(n)} ${n === 1 ? "word" : "words"}`;
}

export function countLabel(n: number, mode: Exclude<CountMode, "off">): string {
  return mode === "words" ? wordLabel(n) : characterLabel(n);
}
