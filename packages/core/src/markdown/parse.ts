/**
 * Markdown to document, built on markdown-it so it runs in Node
 * with no DOM. Custom rules cover single tilde strike, `++underline++`, the four decoded entities,
 * and the supported inline HTML tags.
 */
import type { JSONContent } from "@tiptap/core";
import MarkdownIt, { type MarkdownIt as MarkdownItInstance, type Token } from "markdown-it";
import { HEADING_LEVELS } from "../extensions";
import { normalizeLinkHref } from "../link";
import { delimiterRule } from "./delimiters";

type Mark = NonNullable<JSONContent["marks"]>[number];

export type MarkdownMode = "import" | "paste";

export interface MarkdownOptions {
  mode?: MarkdownMode;
}

const MAX_HEADING: number = Math.max(...HEADING_LEVELS);
const DECODED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', amp: "&" };

let parser: MarkdownItInstance | undefined;

function getParser(): MarkdownItInstance {
  if (parser) return parser;
  const md = new MarkdownIt("default", { html: true, linkify: true, breaks: true, typographer: false });
  md.validateLink = () => true;
  md.normalizeLink = (url) => url;
  md.normalizeLinkText = (url) => url;
  md.linkify.set({ fuzzyEmail: false, fuzzyLink: false });
  md.inline.ruler.at("entity", (state, silent) => {
    const match = /^&(lt|gt|quot|amp);/.exec(state.src.slice(state.pos));
    if (!match) return false;
    if (!silent) {
      const token = state.push("text_special", "", 0);
      token.content = DECODED_ENTITIES[match[1] ?? ""] ?? "";
      token.markup = match[0];
      token.info = "entity";
    }
    state.pos += match[0].length;
    return true;
  });
  const strike = delimiterRule({ marker: "~", lengths: [1, 2], tag: "s" });
  md.inline.ruler.at("strikethrough", strike.tokenize);
  md.inline.ruler2.at("strikethrough", strike.postProcess);
  const underline = delimiterRule({ marker: "+", lengths: [2], tag: "u" });
  md.inline.ruler.after("strikethrough", "underline", underline.tokenize);
  md.inline.ruler2.after("strikethrough", "underline", underline.postProcess);
  parser = md;
  return md;
}

// ---- inline ----

/** Elements HTML knows; their tags are dropped and their text kept. Anything else stays literal. */
const HTML_ELEMENTS = new Set(
  (
    "a abbr address article aside b bdi bdo big blockquote body br caption cite code col colgroup data dd del " +
    "details dfn div dl dt em figcaption figure font footer h1 h2 h3 h4 h5 h6 header hr html i img ins kbd label " +
    "legend li main mark nav ol p pre q rp rt ruby s samp section small span strike strong sub summary sup table " +
    "tbody td tfoot th thead time tr tt u ul var wbr"
  ).split(" "),
);

const TAG_MARKS: Record<string, string> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  u: "underline",
  s: "strike",
  del: "strike",
  strike: "strike",
  code: "code",
};

function attr(token: Token, name: string): string | null {
  const value = token.attrGet(name);
  return value === null ? null : String(value);
}

class InlineBuilder {
  readonly nodes: JSONContent[] = [];
  private readonly marks: Mark[] = [];

  push(mark: Mark): void {
    this.marks.push(mark);
  }

  pop(type: string): void {
    for (let i = this.marks.length - 1; i >= 0; i--) {
      if (this.marks[i]?.type === type) {
        this.marks.splice(i, 1);
        return;
      }
    }
  }

  text(text: string, extra: Mark[] = []): void {
    if (!text) return;
    const marks = [...this.marks, ...extra];
    const previous = this.nodes[this.nodes.length - 1];
    if (previous?.type === "text" && sameMarks(previous.marks, marks)) {
      previous.text = (previous.text ?? "") + text;
      return;
    }
    const node: JSONContent = { type: "text", text };
    if (marks.length) node.marks = marks.map((mark) => ({ ...mark }));
    this.nodes.push(node);
  }

  hardBreak(): void {
    this.nodes.push({ type: "hardBreak" });
  }
}

function sameMarks(a: Mark[] | undefined, b: Mark[]): boolean {
  const left = a ?? [];
  if (left.length !== b.length) return false;
  return left.every((mark, index) => JSON.stringify(mark) === JSON.stringify(b[index]));
}

const WWW = /(^|[\s(])(www\.[^\s<]*[^\s<.,:;!?'")\]])/g;

/** `www.` addresses become links with an http prefix, as GitHub flavored Markdown does. */
function linkifyWww(builder: InlineBuilder, text: string): void {
  let last = 0;
  for (const match of text.matchAll(WWW)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    const address = match[2] ?? "";
    builder.text(text.slice(last, start));
    builder.text(address, [{ type: "link", attrs: { href: `http://${address}`, title: null } }]);
    last = start + address.length;
  }
  builder.text(text.slice(last));
}

function htmlInline(builder: InlineBuilder, raw: string, links: boolean[]): void {
  const match = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>$/.exec(raw.trim());
  if (!match) {
    builder.text(raw);
    return;
  }
  const closing = match[1] === "/";
  const name = (match[2] ?? "").toLowerCase();
  if (name === "br") {
    builder.hardBreak();
    return;
  }
  const markType = TAG_MARKS[name];
  if (markType) {
    if (closing) builder.pop(markType);
    else builder.push({ type: markType });
    return;
  }
  if (name === "a") {
    if (closing) {
      if (links.pop()) builder.pop("link");
      return;
    }
    const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[3] ?? "");
    const href = normalizeLinkHref(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "");
    links.push(href !== null);
    if (href) builder.push({ type: "link", attrs: { href, title: null } });
    return;
  }
  if (HTML_ELEMENTS.has(name)) return;
  builder.text(raw);
}

function inlineContent(tokens: Token[] | null): JSONContent[] {
  const builder = new InlineBuilder();
  const links: boolean[] = [];
  let inLink = 0;
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text":
      case "text_special":
        if (inLink === 0 && token.type === "text") linkifyWww(builder, token.content);
        else builder.text(token.content);
        break;
      case "softbreak":
      case "hardbreak":
        builder.hardBreak();
        break;
      case "code_inline":
        builder.text(token.content, [{ type: "code" }]);
        break;
      case "strong_open":
        builder.push({ type: "bold" });
        break;
      case "strong_close":
        builder.pop("bold");
        break;
      case "em_open":
        builder.push({ type: "italic" });
        break;
      case "em_close":
        builder.pop("italic");
        break;
      case "s_open":
        builder.push({ type: "strike" });
        break;
      case "s_close":
        builder.pop("strike");
        break;
      case "u_open":
        builder.push({ type: "underline" });
        break;
      case "u_close":
        builder.pop("underline");
        break;
      case "link_open": {
        inLink++;
        const raw = attr(token, "href") ?? "";
        const fromLinkify = token.markup === "linkify";
        const href = fromLinkify && !/^https?:\/\//i.test(raw) ? null : normalizeLinkHref(raw);
        links.push(href !== null);
        const title = attr(token, "title");
        if (href) builder.push({ type: "link", attrs: { href, title: title || null } });
        break;
      }
      case "link_close":
        inLink = Math.max(0, inLink - 1);
        if (links.pop()) builder.pop("link");
        break;
      case "image":
        builder.text(imageAlt(token));
        break;
      case "html_inline":
        htmlInline(builder, token.content, links);
        break;
      default:
        if (token.content) builder.text(token.content);
    }
  }
  return builder.nodes;
}

function imageAlt(token: Token): string {
  return (token.children ?? []).map((child) => child.content).join("") || token.content;
}

// ---- blocks ----

interface Cursor {
  tokens: Token[];
  index: number;
}

function paragraph(content: JSONContent[]): JSONContent {
  return content.length ? { type: "paragraph", content } : { type: "paragraph" };
}

function isNbspOnly(source: string): boolean {
  const trimmed = source.replace(/[ \t]/g, "");
  return trimmed === "&nbsp;" || trimmed === " ";
}

/** Reads one block starting at cursor.index and returns its node(s). */
function readBlock(cursor: Cursor): JSONContent[] {
  const token = cursor.tokens[cursor.index];
  if (!token) return [];
  switch (token.type) {
    case "paragraph_open": {
      const inline = cursor.tokens[cursor.index + 1];
      cursor.index += 3;
      if (!inline || isNbspOnly(inline.content)) return [paragraph([])];
      return [paragraph(inlineContent(inline.children))];
    }
    case "heading_open": {
      const inline = cursor.tokens[cursor.index + 1];
      cursor.index += 3;
      const level = Math.min(Number(token.tag.slice(1)) || 1, MAX_HEADING);
      const content = trimInline(inlineContent(inline?.children ?? null));
      return [content.length ? { type: "heading", attrs: { level }, content } : { type: "heading", attrs: { level } }];
    }
    case "blockquote_open": {
      cursor.index++;
      const children = readUntil(cursor, "blockquote_close");
      return [{ type: "blockquote", content: children.length ? children : [paragraph([])] }];
    }
    case "bullet_list_open":
    case "ordered_list_open":
      return readList(cursor);
    case "fence":
    case "code_block": {
      cursor.index++;
      const text = token.content.replace(/\n$/, "");
      const language = token.type === "fence" ? token.info.trim() || null : null;
      const node: JSONContent = { type: "codeBlock", attrs: { language } };
      if (text) node.content = [{ type: "text", text }];
      return [node];
    }
    case "hr":
      cursor.index++;
      return [{ type: "horizontalRule" }];
    case "table_open":
      return [readTable(cursor)];
    case "html_block": {
      cursor.index++;
      return htmlBlock(token.content);
    }
    default:
      cursor.index++;
      return [];
  }
}

function trimInline(nodes: JSONContent[]): JSONContent[] {
  const first = nodes[0];
  if (first?.type === "text") first.text = (first.text ?? "").replace(/^\s+/, "");
  const last = nodes[nodes.length - 1];
  if (last?.type === "text") last.text = (last.text ?? "").replace(/\s+$/, "");
  return nodes.filter((node) => node.type !== "text" || node.text);
}

/** Block HTML without a DOM: each blank line separated chunk becomes a paragraph of its inline content. */
function htmlBlock(content: string): JSONContent[] {
  const md = getParser();
  return content
    .replace(/\n+$/, "")
    .split(/\n\s*\n/)
    .map((chunk) => {
      const tokens = md.parseInline(chunk, {});
      return paragraph(trimInline(inlineContent(tokens[0]?.children ?? null)));
    });
}

function readUntil(cursor: Cursor, closeType: string): JSONContent[] {
  const out: JSONContent[] = [];
  while (cursor.index < cursor.tokens.length) {
    const token = cursor.tokens[cursor.index];
    if (!token || token.type === closeType) {
      cursor.index++;
      break;
    }
    out.push(...readBlock(cursor));
  }
  return out;
}

const TASK_MARKER = /^\[([ xX])\][ \t]+(?=\S)/;

function readList(cursor: Cursor): JSONContent[] {
  const open = cursor.tokens[cursor.index];
  if (!open) return [];
  cursor.index++;
  const ordered = open.type === "ordered_list_open";
  const closeType = ordered ? "ordered_list_close" : "bullet_list_close";
  const start = ordered ? Number(open.attrGet("start") ?? 1) : 1;
  const items: JSONContent[] = [];
  while (cursor.index < cursor.tokens.length) {
    const token = cursor.tokens[cursor.index];
    if (!token || token.type === closeType) {
      cursor.index++;
      break;
    }
    if (token.type !== "list_item_open") {
      cursor.index++;
      continue;
    }
    cursor.index++;
    const children = readUntil(cursor, "list_item_close");
    items.push(listItem(children, ordered ? start + items.length : null));
  }
  return items;
}

function listItem(children: JSONContent[], order: number | null): JSONContent {
  const attrs: Record<string, unknown> = {
    kind: order === null ? "bullet" : "ordered",
    order,
    checked: false,
    collapsed: false,
  };
  const first = children[0];
  if (!first || (first.type !== "paragraph" && first.type !== "list")) children.unshift(paragraph([]));
  const head = children[0];
  if (order === null && head?.type === "paragraph") {
    const lead = head.content?.[0];
    const match = lead?.type === "text" && !lead.marks?.length ? TASK_MARKER.exec(lead.text ?? "") : null;
    if (match && lead) {
      attrs.kind = "task";
      attrs.checked = match[1] !== " ";
      lead.text = (lead.text ?? "").slice(match[0].length);
      if (!lead.text) head.content = head.content?.slice(1);
      if (!head.content?.length) delete head.content;
    }
  }
  return { type: "list", attrs, content: children };
}

function readTable(cursor: Cursor): JSONContent {
  const rows: JSONContent[][] = [];
  let aligns: string[] = [];
  let row: JSONContent[][] | null = null;
  let inHead = false;
  while (cursor.index < cursor.tokens.length) {
    const token = cursor.tokens[cursor.index++];
    if (!token || token.type === "table_close") break;
    if (token.type === "thead_open") inHead = true;
    else if (token.type === "thead_close") inHead = false;
    else if (token.type === "tr_open") row = [];
    else if (token.type === "th_open" && inHead) aligns.push(alignOf(token));
    else if (token.type === "inline" && row) row.push(inlineContent(token.children));
    else if (token.type === "tr_close" && row) {
      rows.push(tableRow(row));
      if (rows.length === 1) rows.push([{ type: "text", text: `|${aligns.map(delimiterCell).join("|")}|` }]);
      row = null;
    }
  }
  aligns = [];
  const content: JSONContent[] = [];
  rows.forEach((cells, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    content.push(...cells);
  });
  return paragraph(mergeText(content));
}

function alignOf(token: Token): string {
  const style = String(token.attrGet("style") ?? "");
  return /text-align:\s*(left|right|center)/.exec(style)?.[1] ?? "";
}

function delimiterCell(align: string): string {
  if (align === "left") return ":---";
  if (align === "right") return "---:";
  if (align === "center") return ":---:";
  return "---";
}

function tableRow(cells: JSONContent[][]): JSONContent[] {
  const out: JSONContent[] = [{ type: "text", text: "| " }];
  cells.forEach((cell, index) => {
    if (index > 0) out.push({ type: "text", text: " | " });
    out.push(...cell);
  });
  out.push({ type: "text", text: " |" });
  return out;
}

function mergeText(nodes: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    const previous = out[out.length - 1];
    if (node.type === "text" && previous?.type === "text" && sameMarks(previous.marks, node.marks ?? [])) {
      previous.text = (previous.text ?? "") + (node.text ?? "");
    } else {
      out.push({ ...node });
    }
  }
  return out.filter((node) => node.type !== "text" || node.text);
}

// ---- document ----

function isBlankLine(line: string | undefined): boolean {
  return line === undefined || line.trim() === "";
}

/** Empty paragraphs for a gap with `newlines` line breaks: pairs minus one between blocks. */
function gapParagraphs(newlines: number, edge: boolean): JSONContent[] {
  const count = Math.floor(newlines / 2) - (edge ? 0 : 1);
  return Array.from({ length: Math.max(0, count) }, () => paragraph([]));
}

/** Parses Markdown into a document with at least one block. */
export function parseMarkdown(markdown: string, options: MarkdownOptions = {}): JSONContent {
  const source = markdown.replace(/\r\n?/g, "\n");
  if (source.trim() === "") return { type: "doc", content: [paragraph([])] };
  const tokens = getParser().parse(source, {});
  const lines = source.split("\n");
  const keepGaps = (options.mode ?? "import") === "import";
  const cursor: Cursor = { tokens, index: 0 };
  const content: JSONContent[] = [];
  let previousEnd: number | null = null;
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index];
    if (!token) break;
    const map = token.map;
    if (keepGaps && map) {
      if (previousEnd === null) content.push(...gapParagraphs(map[0], true));
      else content.push(...gapParagraphs(map[0] - previousEnd + 1, false));
    }
    const nodes = readBlock(cursor);
    content.push(...nodes);
    if (map) {
      let end = map[1];
      while (end - 1 > map[0] && isBlankLine(lines[end - 1])) end--;
      previousEnd = end;
    }
  }
  if (keepGaps) {
    const trailing = source.slice(source.trimEnd().length);
    content.push(...gapParagraphs((trailing.match(/\n/g) ?? []).length, true));
  }
  return { type: "doc", content: content.length ? content : [paragraph([])] };
}
