import type { JSONContent } from "@tiptap/core";
import { docToNode, normalizeDoc } from "../load";
import { parseMarkdown, type MarkdownOptions } from "./parse";
import { nodeToMarkdown } from "./serialize";

export type { MarkdownMode, MarkdownOptions } from "./parse";

/** Markdown to a valid document with at least one block (import mode keeps blank line runs). */
export function markdownToDoc(markdown: string, options: MarkdownOptions = {}): JSONContent {
  return normalizeDoc(parseMarkdown(markdown, options));
}

export function docToMarkdown(doc: JSONContent): string {
  return nodeToMarkdown(docToNode(doc));
}
