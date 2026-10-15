/** Derived plain text, title, and counts. */
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { docToNode } from "./load";
import { LIST } from "./schema/flatList";

function inlineText(node: PMNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.isText) out += child.text ?? "";
    else if (child.type.name === "hardBreak") out += "\n";
  });
  return out;
}

function blockText(node: PMNode): string {
  if (node.isTextblock) return inlineText(node);
  if (node.type.name === LIST) return childrenText(node, "\n", "\n");
  if (node.isLeaf) return "";
  // Blockquote children are joined by single newlines.
  return childrenText(node, "\n", "\n");
}

/** Joins child blocks: `separator` between blocks, `listSeparator` between adjacent list items. */
function childrenText(parent: PMNode, separator: string, listSeparator: string): string {
  let out = "";
  let previous: PMNode | null = null;
  let previousEmitted = false;
  parent.forEach((child) => {
    const text = blockText(child);
    if (text !== "") {
      if (previousEmitted) {
        const adjacentLists = previous?.type.name === LIST && child.type.name === LIST;
        out += adjacentLists ? listSeparator : separator;
      }
      out += text;
      previousEmitted = true;
    }
    previous = child;
  });
  return out;
}

export function nodeToPlainText(doc: PMNode): string {
  return childrenText(doc, "\n\n", "\n");
}

/** The `text` field: blocks separated by a blank line, list items by a newline, no markers. */
export function docToPlainText(doc: JSONContent): string {
  return nodeToPlainText(docToNode(doc));
}

/** The first line of the plain text (empty blocks are skipped there), trimmed, no length cap. */
export function deriveTitle(doc: JSONContent): string {
  const text = docToPlainText(doc);
  const end = text.indexOf("\n");
  return (end === -1 ? text : text.slice(0, end)).trim();
}
