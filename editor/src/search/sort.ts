/**
 * Search's sort menu (board 07, SPEC §7): the fields, the direction and pins toggles, and the meta line under each
 * note, which follows the sort. The choice persists as the `searchSort` setting.
 */
import type { BrowseItem, BrowseSortField, SearchSort } from "@overnote/core";
import { wordLabel } from "../lib/count";
import { relativeTime } from "../lib/relativeTime";

export const SORT_FIELDS: { field: BrowseSortField; label: string }[] = [
  { field: "opened", label: "Last opened" },
  { field: "modified", label: "Modified" },
  { field: "created", label: "Created" },
  { field: "title", label: "Title" },
  { field: "length", label: "Length" },
];

export const sortLabel = (field: BrowseSortField) => SORT_FIELDS.find((f) => f.field === field)?.label ?? "";

const naturalDirection = (field: BrowseSortField) => (field === "title" ? "asc" : "desc");
const flip = (direction: SearchSort["direction"]) => (direction === "asc" ? "desc" : "asc");

/** Whether the order runs the field's natural way: newest, longest, or A to Z first. The toggle shows this. */
export const isNaturalOrder = (sort: SearchSort) => sort.direction === naturalDirection(sort.field);

/** The direction toggle's label: "Newest first" for the dates, and its counterpart for title and length. */
export const directionLabel = (field: BrowseSortField) =>
  field === "title" ? "A to Z" : field === "length" ? "Longest first" : "Newest first";

/** Another field, keeping whether the order runs the natural way. */
export function withField(sort: SearchSort, field: BrowseSortField): SearchSort {
  const direction = naturalDirection(field);
  return { ...sort, field, direction: isNaturalOrder(sort) ? direction : flip(direction) };
}

export const withDirectionFlipped = (sort: SearchSort): SearchSort => ({ ...sort, direction: flip(sort.direction) });

/** The header over the notes after the pinned ones: recency sorts read as "Recent". */
export const restHeader = (field: BrowseSortField) => (field === "opened" || field === "modified" ? "Recent" : "Notes");

export const shortDate = (time: number) =>
  new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * The meta line under a note: what the sort orders by first ("Opened 2 hours ago", "Created Nov 2", the word count
 * for Length), then the word count (or when it was edited, for Length). The current note says "Current" instead.
 */
export function rowMeta(note: BrowseItem, field: BrowseSortField, current: boolean): string {
  const words = wordLabel(note.wordCount);
  const edited = `Edited ${relativeTime(note.updatedAt)}`;
  const lead =
    field === "opened"
      ? `Opened ${relativeTime(note.lastAccessedAt ?? note.updatedAt)}`
      : field === "created"
        ? `Created ${shortDate(note.createdAt)}`
        : field === "length"
          ? words
          : edited;
  if (current) return `Current · ${field === "length" ? lead : lead.charAt(0).toLowerCase() + lead.slice(1)}`;
  return `${lead} · ${field === "length" ? edited : words}`;
}
