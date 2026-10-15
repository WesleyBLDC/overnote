import { displayTitle } from "@overnote/core/text";

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
  manual: "Backed up by hand",
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
