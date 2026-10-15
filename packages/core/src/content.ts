import type { JSONContent } from "@tiptap/core";
import { docToNode, toStoredDoc } from "./load";
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
