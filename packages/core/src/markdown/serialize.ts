/**
 * Document to Markdown. Output always parses back to the same document: list children are indented
 * by the marker width, fences and code spans grow past any backtick run inside, link parentheses and
 * block syntax at the start of a line are escaped, and blocks inside quotes stay tight.
 */
import type { Mark, Node as PMNode } from "@tiptap/pm/model";
import { LIST } from "../schema/flatList";
import { UNKNOWN_BLOCK } from "../schema/placeholders";
import { listMarkers, type ListMarker } from "../serialize/lists";

/** Outermost first. Code is written around the text itself, inside every other mark. */
const MARK_ORDER = ["bold", "italic", "strike", "underline", "link"] as const;
const DELIMITERS: Record<string, string> = { bold: "**", italic: "*", strike: "~~", underline: "++" };
const HTML_TAGS: Record<string, string> = { bold: "strong", italic: "em", strike: "s", underline: "u" };

interface OpenMark {
  mark: Mark;
  html: boolean;
}

function markRank(mark: Mark): number {
  return MARK_ORDER.indexOf(mark.type.name as (typeof MARK_ORDER)[number]);
}

function serializableMarks(marks: readonly Mark[]): Mark[] {
  return marks
    .filter((mark) => markRank(mark) >= 0 && !(mark.type.name === "link" && !mark.attrs.href))
    .sort((a, b) => markRank(a) - markRank(b));
}

function escapeHref(href: string): string {
  return href.replace(/[()]/g, (c) => `\\${c}`);
}

function openMark(open: OpenMark): string {
  if (open.html) return `<${HTML_TAGS[open.mark.type.name] ?? "span"}>`;
  if (open.mark.type.name === "link") return "[";
  return DELIMITERS[open.mark.type.name] ?? "";
}

function closeMark(open: OpenMark): string {
  if (open.html) return `</${HTML_TAGS[open.mark.type.name] ?? "span"}>`;
  if (open.mark.type.name === "link") {
    const href = String(open.mark.attrs.href ?? "");
    const title = open.mark.attrs.title ? ` "${String(open.mark.attrs.title).replace(/"/g, '\\"')}"` : "";
    return `](${escapeHref(href)}${title})`;
  }
  return DELIMITERS[open.mark.type.name] ?? "";
}

const BACKSLASHED = new Set(["\\", "`", "*", "_", "[", "]", "~"]);

/** Escapes text for Markdown. `lineStart` also escapes text that would otherwise start a block. */
export function escapeText(raw: string, lineStart: boolean): string {
  let out = "";
  let i = 0;
  if (lineStart) {
    let match: RegExpExecArray | null;
    if ((match = /^#(?=[ \t]|$)/.exec(raw))) {
      out = "\\#";
      i = 1;
    } else if ((match = /^[-+](?=[ \t]|$)/.exec(raw))) {
      out = `\\${match[0]}`;
      i = 1;
    } else if ((match = /^(\d+)([.)])(?=[ \t]|$)/.exec(raw))) {
      out = `${match[1]}\\${match[2]}`;
      i = match[0].length;
    } else if (/^=+$/.test(raw)) {
      return raw.replace(/=/g, "\\=");
    } else if (/^-{2,}[ \t]*$/.test(raw)) {
      out = "\\-";
      i = 1;
    }
  }
  for (; i < raw.length; i++) {
    const c = raw[i] ?? "";
    if (c === "&") out += "&amp;";
    else if (c === "<") out += "&lt;";
    else if (c === ">") out += "&gt;";
    else if (c === "+" && raw[i + 1] === "+" && i + 2 < raw.length && !/\s/.test(raw[i + 2] ?? "")) {
      out += "\\+\\+";
      i++;
    } else if (BACKSLASHED.has(c)) out += `\\${c}`;
    else out += c;
  }
  return out;
}

/** Inline code with a delimiter longer than any backtick run inside. */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Serializes the inline content of a text block. */
export function inlineToMarkdown(block: PMNode): string {
  let out = "";
  let active: OpenMark[] = [];
  let lineStart = true;

  const closeFrom = (index: number) => {
    const trailing = /[ \t]+$/.exec(out)?.[0] ?? "";
    if (trailing) out = out.slice(0, -trailing.length);
    for (let i = active.length - 1; i >= index; i--) {
      const open = active[i];
      if (open) out += closeMark(open);
    }
    out += trailing;
    active = active.slice(0, index);
  };

  block.forEach((node) => {
    if (node.type.name === "hardBreak") {
      closeFrom(0);
      out += "  \n";
      lineStart = true;
      return;
    }
    if (!node.isText) return;
    const raw = node.text ?? "";
    const isCode = node.marks.some((mark) => mark.type.name === "code");
    const marks = serializableMarks(node.marks);
    if (!isCode && raw.trim() === "") {
      // Whitespace alone never opens a mark; it only keeps marks that are already open.
      const drop = active.findIndex((open) => !marks.some((mark) => mark.eq(open.mark)));
      if (drop !== -1) closeFrom(drop);
      out += escapeText(raw, false);
      return;
    }
    let drop = active.findIndex((open) => !marks.some((mark) => mark.eq(open.mark)));
    if (drop === -1) drop = active.length;
    const reopen = active.slice(drop).filter((open) => marks.some((mark) => mark.eq(open.mark)));
    if (drop < active.length) closeFrom(drop);
    const leading = /^[ \t]+/.exec(raw)?.[0] ?? "";
    const toOpen: OpenMark[] = [
      ...reopen.map((open) => ({ mark: open.mark, html: open.mark.type.name !== "link" })),
      ...marks
        .filter((mark) => !active.some((open) => open.mark.eq(mark)) && !reopen.some((open) => open.mark.eq(mark)))
        .map((mark) => ({ mark, html: false })),
    ];
    let body = raw;
    if (toOpen.length && leading && !isCode) {
      out += leading;
      body = raw.slice(leading.length);
    }
    for (const open of toOpen) {
      out += openMark(open);
      active.push(open);
    }
    const atLineStart = lineStart && active.length === 0;
    out += isCode ? codeSpan(body) : escapeText(body, atLineStart);
    lineStart = false;
  });
  closeFrom(0);
  return out;
}

function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/^`{3,}/gm), (m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function indentLines(text: string, width: number): string {
  const pad = " ".repeat(width);
  return text
    .split("\n")
    .map((line) => (line === "" ? line : pad + line))
    .join("\n");
}

function isEmptyParagraph(node: PMNode | null | undefined): boolean {
  return !!node && node.type.name === "paragraph" && node.content.size === 0;
}

function renderBlock(node: PMNode, marker: ListMarker | null, previous: PMNode | null, inContainer: boolean): string {
  switch (node.type.name) {
    case "paragraph":
      if (node.content.size === 0) return inContainer && isEmptyParagraph(previous) ? "&nbsp;" : "";
      return inlineToMarkdown(node);
    case "heading":
      return `${"#".repeat(Number(node.attrs.level) || 1)} ${inlineToMarkdown(node)}`;
    case "codeBlock": {
      const text = node.textContent;
      const fence = fenceFor(text);
      return `${fence}${node.attrs.language ?? ""}\n${text}\n${fence}`;
    }
    case "blockquote":
      return renderChildren(node, true)
        .split("\n")
        .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
        .join("\n");
    case "horizontalRule":
      return "---";
    case LIST:
      return renderListItem(node, marker ?? { marker: "-", width: 2 });
    case UNKNOWN_BLOCK:
      return "";
    default:
      return node.textContent;
  }
}

function renderListItem(item: PMNode, { marker, width }: ListMarker): string {
  const markers = listMarkers(item, "markdown");
  let out = "";
  let previous: PMNode | null = null;
  item.forEach((child, _offset, index) => {
    if (index === 0) {
      if (child.type.name === "paragraph" && child.content.size > 0) {
        out = `${marker} ${inlineToMarkdown(child)}`;
      } else if (child.type.name === "paragraph") {
        out = marker;
      } else {
        out = `${marker}\n${indentLines(renderBlock(child, markers[index] ?? null, null, true), width)}`;
      }
      previous = child;
      return;
    }
    if (child.type.name === UNKNOWN_BLOCK) return;
    const rendered = indentLines(renderBlock(child, markers[index] ?? null, previous, true), width);
    const tight = child.type.name === LIST && (previous?.type.name === LIST || index === 1);
    out += (tight ? "\n" : "\n\n") + rendered;
    previous = child;
  });
  return out;
}

/** Joins child blocks: a newline between list items, a blank line otherwise. */
function renderChildren(parent: PMNode, inContainer: boolean): string {
  const markers = listMarkers(parent, "markdown");
  const parts: string[] = [];
  let previous: PMNode | null = null;
  parent.forEach((child, _offset, index) => {
    if (child.type.name === UNKNOWN_BLOCK) return;
    const rendered = renderBlock(child, markers[index] ?? null, previous, inContainer);
    if (parts.length > 0) parts.push(previous?.type.name === LIST && child.type.name === LIST ? "\n" : "\n\n");
    parts.push(rendered);
    previous = child;
  });
  return parts.join("");
}

export function nodeToMarkdown(doc: PMNode): string {
  let target = doc;
  const last = doc.lastChild;
  if (doc.childCount > 1 && isEmptyParagraph(last))
    target = doc.copy(doc.content.cut(0, doc.content.size - (last?.nodeSize ?? 0)));
  const out = renderChildren(target, false).replace(/\n+$/, "");
  if (out.replace(/&nbsp;|\u00a0/g, "").trim() === "") return "";
  return out;
}
