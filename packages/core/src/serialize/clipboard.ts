/** The ⌘C / ⌘X clipboard flavors (spec/serialization.md section 6). */
import type { JSONContent } from "@tiptap/core";
import { Fragment, type Mark, type Node as PMNode } from "@tiptap/pm/model";
import { getNoteSchema } from "../extensions";
import { docToNode } from "../load";
import { UNKNOWN_BLOCK } from "../schema/placeholders";
import { escapeHtml, inlineHtml, simpleClose, simpleOpen } from "./inlineHtml";
import { isList, listMarkers, orderNumbers } from "./lists";

const ORDER = ["link", "italic", "bold", "strike", "underline", "code"] as const;

function openMark(mark: Mark): string {
  return mark.type.name === "link" ? `<a href="${escapeHtml(String(mark.attrs.href ?? ""), true)}">` : simpleOpen(mark);
}

const inline = (node: PMNode) => inlineHtml(node, { order: ORDER, open: openMark, close: simpleClose, quotes: true });

function inlineText(node: PMNode): string {
  let out = "";
  node.forEach((child) => {
    if (child.isText) out += child.text ?? "";
    else if (child.type.name === "hardBreak") out += "\n";
  });
  return out;
}

function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/^`{3,}/gm), (m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function indent(text: string, width: number): string {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

// ---- plain text flavor ----

function blockText(node: PMNode, marker: { marker: string; width: number } | null): string {
  switch (node.type.name) {
    case "paragraph":
      return inlineText(node);
    case "heading":
      return `${"#".repeat(Number(node.attrs.level) || 1)} ${inlineText(node)}`;
    case "blockquote": {
      const inner = childrenText(node, "\n\n");
      if (!inner) return "";
      return `${inner
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n> `;
    }
    case "codeBlock": {
      const text = node.textContent;
      const fence = fenceFor(text);
      return `${fence}${node.attrs.language ?? ""}\n${text}\n${fence}`;
    }
    case "horizontalRule":
      return "---";
    case "list":
      return listItemText(node, marker ?? { marker: "-", width: 2 });
    case UNKNOWN_BLOCK:
      return "";
    default:
      return node.textContent;
  }
}

function listItemText(item: PMNode, { marker, width }: { marker: string; width: number }): string {
  const markers = listMarkers(item, "clipboard");
  const lines: string[] = [];
  item.forEach((child, _offset, index) => {
    if (index === 0 && child.type.name === "paragraph") {
      lines.push(`${marker} ${inlineText(child)}`);
      return;
    }
    if (index === 0) lines.push(marker);
    const text = blockText(child, markers[index] ?? null);
    if (text) lines.push(indent(text, width));
  });
  return lines.join("\n");
}

function childrenText(parent: PMNode, separator: string): string {
  const markers = listMarkers(parent, "clipboard");
  let out = "";
  let previous: PMNode | null = null;
  parent.forEach((child, _offset, index) => {
    const text = blockText(child, markers[index] ?? null);
    if (text === "") return;
    if (out) out += isList(previous) && isList(child) ? "\n" : separator;
    out += text;
    previous = child;
  });
  return out;
}

// ---- HTML flavor ----

function blockHtml(node: PMNode): string {
  switch (node.type.name) {
    case "paragraph":
      return node.content.size ? `<div>${inline(node)}</div>` : "<div><br></div>";
    case "heading": {
      const level = Number(node.attrs.level) || 1;
      return `<h${level}>${inline(node)}</h${level}>`;
    }
    case "blockquote":
      return `<blockquote>${childrenHtml(node, 0, true)}</blockquote>`;
    case "codeBlock": {
      const language = node.attrs.language ? ` class="language-${escapeHtml(String(node.attrs.language), true)}"` : "";
      return `<pre><code${language}>${escapeHtml(node.textContent, true)}</code></pre>`;
    }
    case "horizontalRule":
      return "<hr>";
    case UNKNOWN_BLOCK:
      return "";
    default:
      return escapeHtml(node.textContent, true);
  }
}

function listItemHtml(item: PMNode): string {
  let out = "<li>";
  if (item.attrs.kind === "task") out += `<input type="checkbox"${item.attrs.checked ? " checked" : ""} disabled>`;
  const first = item.firstChild;
  const from = first?.type.name === "paragraph" ? 1 : 0;
  if (from === 1 && first) out += inline(first);
  out += childrenHtml(item, from, false);
  return `${out}</li>`;
}

/**
 * Consecutive same-kind siblings share one list element when `share` is set (the top level and
 * quotes); nested items each get their own list element.
 */
function childrenHtml(parent: PMNode, from: number, share: boolean, sliceAttr = ""): string {
  const numbers = orderNumbers(parent);
  let out = "";
  let openKind: string | null = null;
  let openTag = "";
  let first = true;
  parent.forEach((child, _offset, index) => {
    if (index < from) return;
    const marker = first && sliceAttr ? sliceAttr : "";
    first = false;
    if (!isList(child)) {
      if (openKind) out += `</${openTag}>`;
      openKind = null;
      out += blockHtml(child);
      return;
    }
    const kind = String(child.attrs.kind);
    if (!share || openKind !== kind) {
      if (openKind) out += `</${openTag}>`;
      openTag = kind === "ordered" ? "ol" : "ul";
      const number = numbers.get(index) ?? 1;
      const start = kind === "ordered" && number !== 1 ? ` start="${number}"` : "";
      out += `<${openTag}${marker}${start}>`;
      openKind = kind;
    }
    out += listItemHtml(child);
    if (!share) {
      out += `</${openTag}>`;
      openKind = null;
    }
  });
  if (openKind) out += `</${openTag}>`;
  return out;
}

// ---- entry point ----

interface SliceJSON extends JSONContent {
  openStart?: number;
  openEnd?: number;
}

/** Plain text and HTML for copying a document or a slice of one. */
export function docToClipboard(docOrSlice: SliceJSON): { text: string; html: string } {
  const schema = getNoteSchema();
  const isSlice = docOrSlice.type !== "doc";
  const openStart = docOrSlice.openStart ?? 0;
  const openEnd = docOrSlice.openEnd ?? 0;
  let container: PMNode;
  if (isSlice) {
    const content = Fragment.fromJSON(schema, docOrSlice.content ?? []);
    const only = content.childCount === 1 ? content.firstChild : null;
    if (only?.isTextblock && openStart > 0) {
      return { text: inlineText(only), html: inline(only) };
    }
    if (content.childCount > 0 && content.firstChild?.isInline) {
      const paragraph = schema.node("paragraph", null, content);
      return { text: inlineText(paragraph), html: inline(paragraph) };
    }
    container = schema.node("doc", null, content.childCount ? content : schema.node("paragraph"));
  } else {
    container = docToNode(docOrSlice);
  }
  const sliceAttr = ` data-pm-slice="${openStart} ${openEnd} []"`;
  return {
    text: childrenText(container, "\n\n"),
    html: childrenHtml(container, 0, true, isList(container.firstChild) ? sliceAttr : ""),
  };
}
