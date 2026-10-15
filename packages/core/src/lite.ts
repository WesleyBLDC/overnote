/**
 * The light entry point `@overnote/core/text`: types, rpc constants, and text helpers with no
 * Tiptap or ProseMirror imports, for callers that only list and display notes.
 */
export * from "./types";
export * as rpc from "./rpc";

export const UNTITLED = "Untitled";

function firstLine(text: string): string {
  const end = text.indexOf("\n");
  return (end === -1 ? text : text.slice(0, end)).trim();
}

/** The title to show everywhere: the stored title, else the first non-empty line of text, else "Untitled". */
export function displayTitle(note: { title: string; text: string }): string {
  return note.title.trim() || firstLine(note.text.trimStart()) || UNTITLED;
}

/** First 200 characters of the text with newlines collapsed to single spaces. */
export function derivePreview(text: string): string {
  const collapsed = text.replace(/\s*\n\s*/g, " ").trim();
  return Array.from(collapsed).slice(0, 200).join("");
}

/** Case and diacritic folding used for filter matching. */
export function fold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

let graphemes: Intl.Segmenter | undefined;
let words: Intl.Segmenter | undefined;

/** Grapheme clusters of the trimmed text. */
export function countCharacters(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  graphemes ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let count = 0;
  for (const _ of graphemes.segment(trimmed)) count++;
  return count;
}

/** Word-like segments from a locale word segmenter; punctuation and emoji do not count. */
export function countWords(text: string): number {
  words ??= new Intl.Segmenter(undefined, { granularity: "word" });
  let count = 0;
  for (const segment of words.segment(text)) if (segment.isWordLike) count++;
  return count;
}
