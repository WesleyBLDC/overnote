import { displayTitle } from "@overnote/core/text";

import { foldForMatch } from "./fold";
import type { BackupReason } from "./types";

export { displayTitle };

/** Display title for a list row, which carries a preview instead of the full text. */
export function summaryTitle(note: { title: string; preview: string }): string {
  return displayTitle({ title: note.title, text: note.preview });
}

/** The preview without the line that already serves as the title, collapsed to one line. */
export function previewWithoutTitle(note: { title: string; preview: string }): string {
  const preview = note.preview.trim();
  const title = note.title.trim();
  const body = title.length > 0 && preview.startsWith(title) ? preview.slice(title.length) : preview;
  return body.replace(/\s+/g, " ").trim();
}

export function characterCount(count: number): string {
  return count === 1 ? "1 character" : `${count.toLocaleString("en-US")} characters`;
}

export function wordCount(count: number): string {
  return count === 1 ? "1 word" : `${count.toLocaleString("en-US")} words`;
}

/** One pinned note's place in pin order, where the first nine places have a keyboard shortcut. */
export interface PinPosition {
  /** One based place in pin order. */
  index: number;
  total: number;
  isFirst: boolean;
  isLast: boolean;
}

/**
 * Places for every pinned note in the order given, which callers keep in pin order.
 * The result is only meaningful for a complete pinned list, so callers omit it for filtered lists.
 */
export function pinPositions<T extends { id: string; pinned: number | null }>(notes: T[]): Map<string, PinPosition> {
  const pinned = notes.filter((note) => note.pinned !== null);
  const positions = new Map<string, PinPosition>();
  pinned.forEach((note, offset) => {
    positions.set(note.id, {
      index: offset + 1,
      total: pinned.length,
      isFirst: offset === 0,
      isLast: offset === pinned.length - 1,
    });
  });
  return positions;
}

/** The pinned state for detail metadata, naming the shortcut for the first nine pinned notes. */
export function pinnedLabel(note: { pinned: number | null }, position?: PinPosition): string {
  if (note.pinned === null) return "Not pinned";
  if (!position) return "Pinned";
  const place = `Pinned ${position.index} of ${position.total}`;
  return position.index <= 9 ? `${place} (⌘${position.index})` : place;
}

/**
 * Context around the first match in the preview body, for a list subtitle while searching.
 * Returns undefined when the body has no match, for example when only the title matched.
 */
export function searchSnippet(note: { title: string; preview: string }, query: string): string | undefined {
  const body = previewWithoutTitle(note);
  const needle = foldForMatch(query.trim());
  if (!body || !needle) return undefined;
  const foldedChars: string[] = [];
  const foldedToBody: number[] = [];
  for (let offset = 0; offset < body.length;) {
    const char = String.fromCodePoint(body.codePointAt(offset) ?? 0);
    const folded = foldForMatch(char);
    for (let index = 0; index < folded.length; index++) foldedToBody.push(offset);
    foldedChars.push(folded);
    offset += char.length;
  }
  foldedToBody.push(body.length);
  const foldedBody = foldedChars.join("");
  const match = foldedBody.indexOf(needle);
  if (match === -1) return undefined;
  const matchStart = foldedToBody[match] ?? 0;
  const matchEnd = foldedToBody[match + needle.length] ?? body.length;
  const start = Math.max(0, matchStart - 40);
  const end = Math.min(body.length, matchEnd + 60);
  return `${start > 0 ? "…" : ""}${body.slice(start, end).trim()}${end < body.length ? "…" : ""}`;
}

export const TRASH_RETENTION_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days left before a trashed note is permanently removed, rounded up and never negative. */
export function daysUntilPermanentRemoval(deletedAt: number, now: number = Date.now()): number {
  const remaining = deletedAt + TRASH_RETENTION_DAYS * DAY_MS - now;
  return remaining <= 0 ? 0 : Math.ceil(remaining / DAY_MS);
}

export function daysRemainingLabel(deletedAt: number, now: number = Date.now()): string {
  const days = daysUntilPermanentRemoval(deletedAt, now);
  if (days === 0) return "Due for removal today";
  return days === 1 ? "1 day left" : `${days} days left`;
}

/** Escapes non-ASCII characters as numeric entities, for the HTML clipboard flavor. */
export function escapeNonAscii(html: string): string {
  let out = "";
  for (const char of html) {
    const code = char.codePointAt(0) ?? 0;
    out += code > 0x7e ? `&#${code};` : char;
  }
  return out;
}

const REASON_LABEL: Record<BackupReason, string> = {
  manual: "Manual backup",
  daily: "Daily backup",
  "pre-migration": "Before a database upgrade",
  "pre-update": "Before an update",
  "pre-restore": "Before a restore",
};

export function backupReasonLabel(reason: BackupReason): string {
  return REASON_LABEL[reason] ?? reason;
}

export function backupDate(createdAt: number): string {
  return new Date(createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
