import { displayTitle } from "@better-notes/core/text";

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
