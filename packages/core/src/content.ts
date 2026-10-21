import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { docToNode, loadDoc, toStoredDoc } from "./load";
import { markdownToDoc } from "./markdown";
import { nodeToMarkdown } from "./markdown/serialize";
import { nodeToPlainText } from "./plainText";
import type { NoteContent } from "./types";

function firstLine(text: string): string {
  const end = text.indexOf("\n");
  return (end === -1 ? text : text.slice(0, end)).trim();
}

/** Derives every stored content field from one document. */
export function buildNoteContent(doc: JSONContent): NoteContent {
  const node = docToNode(doc);
  const text = nodeToPlainText(node);
  return {
    rawContent: JSON.stringify(toStoredDoc(node.toJSON() as JSONContent)),
    markdown: nodeToMarkdown(node),
    text,
    title: firstLine(text),
  };
}

export function noteContentFromMarkdown(markdown: string): NoteContent {
  return buildNoteContent(markdownToDoc(markdown));
}

/**
 * The position right after the last non-space character of a textblock's first line (a line ends
 * at a hard break or a newline inside its text), or the line's start when that line is blank.
 */
function titleLineEnd(block: PMNode, start: number): number {
  let end = start;
  let done = false;
  block.forEach((child, offset) => {
    if (done) return;
    if (child.type.name === "hardBreak") {
      done = true;
    } else if (child.isText) {
      const text = child.text ?? "";
      const newline = text.indexOf("\n");
      const kept = (newline === -1 ? text : text.slice(0, newline)).trimEnd().length;
      if (kept > 0) end = start + offset + kept;
      done = newline !== -1;
    }
  });
  return end;
}

/** Whether a textblock contributes to the plain text (text or a hard break, as in plainText.ts). */
function hasPlainText(block: PMNode): boolean {
  let found = false;
  block.forEach((child) => {
    if ((child.isText && child.text) || child.type.name === "hardBreak") found = true;
  });
  return found;
}

/**
 * Inserts `suffix` as plain text at the end of the line the title comes from: the first textblock
 * with any text (as in deriveTitle, which skips empty blocks), after its last non-space character
 * on the first line, or the first textblock when the note has no text. On a blank line the suffix
 * starts the line, so its leading spaces are dropped rather than added to the document.
 */
function appendToTitleLine(node: PMNode, suffix: string): PMNode {
  let at: number | null = null;
  let lineStart: number | null = null;
  node.descendants((child, pos) => {
    if (at !== null) return false;
    if (!child.isTextblock) return true;
    const hasText = hasPlainText(child);
    if (hasText || lineStart === null) lineStart = pos + 1;
    if (hasText) at = titleLineEnd(child, pos + 1);
    return false;
  });
  // Every valid document has a textblock: a doc and a list item both start with a paragraph or a list.
  if (lineStart === null) return node;
  const position = at ?? lineStart;
  const text = position === lineStart ? suffix.trimStart() : suffix;
  if (text === "") return node;
  return new Transform(node).insert(position, node.type.schema.text(text)).doc;
}

/**
 * The content for a copy of a note whose title ends in `titleSuffix` (for example " (Copy)").
 * The suffix goes into the document's first line, and every field is derived from the result,
 * so the title, rawContent, markdown, and text agree and a later save keeps the suffixed title.
 */
export function duplicateContent(note: Pick<NoteContent, "rawContent" | "text">, titleSuffix: string): NoteContent {
  const doc = loadDoc(note.rawContent, note.text);
  if (titleSuffix === "") return buildNoteContent(doc);
  return buildNoteContent(appendToTitleLine(docToNode(doc), titleSuffix).toJSON() as JSONContent);
}
