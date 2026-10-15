import { docToHTML, noteContentFromMarkdown } from "@better-notes/core";

import type { Note, NoteContent } from "../domain/types";

/** Builds every stored content field from markdown, in core (the helper never parses markdown). */
export function contentFromMarkdown(markdown: string): NoteContent {
  return noteContentFromMarkdown(markdown);
}

/** Renders a stored note to HTML from its canonical ProseMirror JSON. */
export function noteToHTML(note: Pick<Note, "rawContent" | "markdown">): string {
  try {
    return docToHTML(JSON.parse(note.rawContent));
  } catch {
    return docToHTML(JSON.parse(noteContentFromMarkdown(note.markdown).rawContent));
  }
}
