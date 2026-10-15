import type { NoteSummary } from "./types";

export type SectionName = "Pinned" | "Today" | "Yesterday" | "This Week" | "This Month" | "Older";

export const SECTION_ORDER: readonly SectionName[] = [
  "Pinned",
  "Today",
  "Yesterday",
  "This Week",
  "This Month",
  "Older",
];

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** The date bucket for an unpinned note's last edit, in local time with weeks starting Monday. */
export function dateSection(updatedAt: number, now: Date = new Date()): Exclude<SectionName, "Pinned"> {
  const today = startOfDay(now);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
  const daysSinceMonday = (now.getDay() + 6) % 7;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (updatedAt >= today) return "Today";
  if (updatedAt >= yesterday) return "Yesterday";
  if (updatedAt >= weekStart) return "This Week";
  if (updatedAt >= monthStart) return "This Month";
  return "Older";
}

/**
 * Splits a page into Search Notes sections: Pinned keeps its incoming (pin) order, and the rest
 * are bucketed by last edit while keeping their incoming order. Empty sections are dropped.
 */
export function groupIntoSections<T extends Pick<NoteSummary, "pinned" | "updatedAt">>(
  notes: T[],
  now: Date = new Date(),
): { name: SectionName; notes: T[] }[] {
  const buckets = new Map<SectionName, T[]>(SECTION_ORDER.map((name) => [name, []]));
  for (const note of notes) {
    const name = note.pinned !== null ? "Pinned" : dateSection(note.updatedAt, now);
    buckets.get(name)?.push(note);
  }
  return SECTION_ORDER.map((name) => ({ name, notes: buckets.get(name) ?? [] })).filter(
    (section) => section.notes.length > 0,
  );
}
