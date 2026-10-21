import { docToClipboard, docToHTML, loadDoc, noteContentFromMarkdown } from "@overnote/core";

/** A copy's content with a title suffix in its first line, built in core so title and content agree. */
export { duplicateContent } from "@overnote/core";

import type { Note, NoteContent } from "../domain/types";

/** Builds every stored content field from markdown, in core (the helper never parses markdown). */
export function contentFromMarkdown(markdown: string): NoteContent {
  return noteContentFromMarkdown(markdown);
}

/** Renders a stored note to HTML from its canonical document (falling back to its text). */
export function noteToHTML(note: Pick<Note, "rawContent" | "text">): string {
  return docToHTML(loadDoc(note.rawContent, note.text));
}

/** The text and HTML clipboard flavors for Copy Content (same as the editor's ⌘C). */
export function noteClipboard(note: Pick<Note, "rawContent" | "text">): { text: string; html: string } {
  return docToClipboard(loadDoc(note.rawContent, note.text));
}
