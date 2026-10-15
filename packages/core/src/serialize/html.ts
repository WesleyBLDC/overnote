/** Semantic HTML export (spec/serialization.md section 5, deviation D18). */
import type { JSONContent } from "@tiptap/core";
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import { docToNode } from "../load";
import { UNKNOWN_BLOCK } from "../schema/placeholders";
import { escapeHtml, inlineHtml, simpleClose, simpleOpen } from "./inlineHtml";
import { isList, orderNumbers } from "./lists";

const ORDER = ["bold", "italic", "strike", "underline", "code", "link"] as const;

function openMark(mark: Mark): string {
  if (mark.type.name !== "link") return simpleOpen(mark);
  const title = mark.attrs.title ? ` title="${escapeHtml(String(mark.attrs.title), true)}"` : "";
  return `<a href="${escapeHtml(String(mark.attrs.href ?? ""), true)}"${title} rel="noopener noreferrer" target="_blank">`;
}

const inline = (node: PMNode) => inlineHtml(node, { order: ORDER, open: openMark, close: simpleClose, quotes: false });

function block(node: PMNode): string {
  switch (node.type.name) {
    case "paragraph":
      return `<p>${inline(node)}</p>`;
    case "heading": {
      const level = Number(node.attrs.level) || 1;
      return `<h${level}>${inline(node)}</h${level}>`;
    }
    case "blockquote":
      return `<blockquote>${children(node)}</blockquote>`;
    case "codeBlock": {
      const language = node.attrs.language ? ` class="language-${escapeHtml(String(node.attrs.language), true)}"` : "";
      return `<pre><code${language}>${escapeHtml(node.textContent)}</code></pre>`;
    }
    case "horizontalRule":
      return "<hr>";
    case UNKNOWN_BLOCK:
      return "";
    default:
      return escapeHtml(node.textContent);
  }
}

function listItem(item: PMNode): string {
  let out = "<li>";
  if (item.attrs.kind === "task") out += `<input type="checkbox"${item.attrs.checked ? " checked" : ""} disabled>`;
  const first = item.firstChild;
  let rest = 0;
  if (first?.type.name === "paragraph") {
    out += inline(first);
    rest = 1;
  }
  out += children(item, rest);
  return `${out}</li>`;
}

/** Renders `parent`'s children from `from`, grouping consecutive list items into ul / ol (H1.8). */
function children(parent: PMNode, from = 0): string {
  const numbers = orderNumbers(parent);
  let out = "";
  let group: { tag: string; kind: string; last: number } | null = null;
  const closeGroup = () => {
    if (group) out += `</${group.tag}>`;
    group = null;
  };
  parent.forEach((child, _offset, index) => {
    if (index < from) return;
    if (!isList(child)) {
      closeGroup();
      out += block(child);
      return;
    }
    const kind = String(child.attrs.kind);
    const number = numbers.get(index) ?? 0;
    const current = group as { tag: string; kind: string; last: number } | null;
    const continues = current && current.kind === kind && (kind !== "ordered" || number === current.last + 1);
    if (!continues) {
      closeGroup();
      const tag = kind === "ordered" ? "ol" : "ul";
      out += kind === "ordered" && number !== 1 ? `<ol start="${number}">` : `<${tag}>`;
      group = { tag, kind, last: number };
    } else if (current) {
      current.last = number;
    }
    out += listItem(child);
  });
  closeGroup();
  return out;
}

export function nodeToHTML(doc: PMNode): string {
  return children(doc) || "<p></p>";
}

export function docToHTML(doc: JSONContent): string {
  return nodeToHTML(docToNode(doc));
}
