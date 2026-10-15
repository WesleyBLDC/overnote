/**
 * Loading stored documents into the schema and mapping them back for storage.
 * Unknown nodes and marks are kept in hidden placeholders so newer content survives a round trip.
 */
import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode, NodeType, Schema } from "@tiptap/pm/model";
import { getNoteSchema, HEADING_LEVELS } from "./extensions";
import { UNKNOWN_BLOCK, UNKNOWN_INLINE, UNKNOWN_MARKS } from "./schema/placeholders";

const MAX_HEADING: number = Math.max(...HEADING_LEVELS);

type Json = JSONContent & { [key: string]: unknown };

/** A document with one empty paragraph. */
export function emptyDoc(): JSONContent {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

/** One paragraph whose lines are separated by hard breaks. */
export function docFromPlainText(text: string): JSONContent {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const content: JSONContent[] = [];
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: "hardBreak" });
    if (line) content.push({ type: "text", text: line });
  });
  return { type: "doc", content: [content.length ? { type: "paragraph", content } : { type: "paragraph" }] };
}

function knownAttrs(spec: { attrs?: Record<string, unknown> } | undefined, attrs: Record<string, unknown> | undefined) {
  if (!attrs || !spec?.attrs) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(spec.attrs)) if (key in attrs) out[key] = attrs[key];
  return Object.keys(out).length ? out : undefined;
}

interface MapResult {
  node: JSONContent;
  preserved: boolean;
}

function mapMarks(schema: Schema, marks: JSONContent["marks"]): { marks?: JSONContent["marks"]; preserved: boolean } {
  if (!marks || marks.length === 0) return { preserved: false };
  const known: NonNullable<JSONContent["marks"]> = [];
  const unknown: unknown[] = [];
  for (const mark of marks) {
    const type = schema.marks[mark.type];
    if (!type || mark.type === UNKNOWN_MARKS) {
      if (mark.type === UNKNOWN_MARKS) unknown.push(...((mark.attrs?.marks as unknown[]) ?? []));
      else unknown.push(mark);
      continue;
    }
    const attrs = knownAttrs(type.spec, mark.attrs);
    known.push(attrs ? { type: mark.type, attrs } : { type: mark.type });
  }
  if (unknown.length) known.push({ type: UNKNOWN_MARKS, attrs: { marks: unknown } });
  return { marks: known.length ? known : undefined, preserved: unknown.length > 0 };
}

function splitNewlines(nodes: JSONContent[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const node of nodes) {
    if (node.type !== "text" || !node.text?.includes("\n")) {
      out.push(node);
      continue;
    }
    node.text.split("\n").forEach((part, index) => {
      if (index > 0) out.push({ type: "hardBreak" });
      if (part) out.push({ ...node, text: part });
    });
  }
  return out;
}

function mapNode(schema: Schema, json: JSONContent, inline: boolean): MapResult {
  const type = json.type ? schema.nodes[json.type] : undefined;
  if (!type || json.type === UNKNOWN_BLOCK || json.type === UNKNOWN_INLINE) {
    const existing = json.type === UNKNOWN_BLOCK || json.type === UNKNOWN_INLINE;
    const original = existing ? json.attrs?.json : json;
    const attrs: Record<string, unknown> = { json: original };
    if (!inline && existing && json.attrs?.padded) attrs.padded = true;
    return { node: { type: inline ? UNKNOWN_INLINE : UNKNOWN_BLOCK, attrs }, preserved: true };
  }
  if (json.type === "text") {
    const { marks, preserved } = mapMarks(schema, json.marks);
    const node: JSONContent = { type: "text", text: json.text ?? "" };
    if (marks) node.marks = marks;
    return { node, preserved };
  }
  let preserved = false;
  const node: JSONContent = { type: json.type };
  const attrs = knownAttrs(type.spec, json.attrs);
  if (attrs) node.attrs = attrs;
  if (json.type === "heading") {
    const raw = Number(node.attrs?.level ?? 1);
    const level = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), MAX_HEADING) : 1;
    node.attrs = { ...node.attrs, level };
  }
  if (json.content?.length) {
    const childInline = type.inlineContent;
    let children = json.content.map((child) => {
      const result = mapNode(schema, child, childInline);
      preserved ||= result.preserved;
      return result.node;
    });
    if (childInline && !type.spec.code) children = splitNewlines(children);
    children = children.filter((child) => child.type !== "text" || (child.text ?? "").length > 0);
    children = padLeadingPlaceholder(schema, type, children);
    if (children.length) node.content = children;
  }
  return { node, preserved };
}

/** A container that must start with a text block gets an empty padding paragraph before a placeholder. */
function padLeadingPlaceholder(schema: Schema, type: NodeType, children: JSONContent[]): JSONContent[] {
  const first = children[0];
  const placeholder = schema.nodes[UNKNOWN_BLOCK];
  if (!first || first.type !== UNKNOWN_BLOCK || !placeholder) return children;
  if (type.contentMatch.matchType(placeholder)) return children;
  return [{ type: "paragraph" }, { ...first, attrs: { ...first.attrs, padded: true } }, ...children.slice(1)];
}

function checked(schema: Schema, json: JSONContent): PMNode | null {
  try {
    const node = schema.nodeFromJSON(json);
    node.check();
    return node;
  } catch {
    return null;
  }
}

function plainTextOf(node: PMNode): string {
  return node.textBetween(0, node.content.size, "\n", "\n");
}

/**
 * Turns stored content into a document for the editor and the serializers.
 * Falls back to the stored plain text when the rich content is unusable.
 */
export function loadDoc(rawContent: string | null | undefined, text = ""): JSONContent {
  let parsed: unknown;
  try {
    parsed = rawContent ? JSON.parse(rawContent) : null;
  } catch {
    parsed = null;
  }
  const result = loadJson(parsed as JSONContent | null);
  if (result && (text.trim() === "" || result.preserved || plainTextOf(result.node).trim() !== "")) {
    return result.node.toJSON() as JSONContent;
  }
  return text ? docFromPlainText(text) : emptyDoc();
}

function loadJson(json: JSONContent | null): { node: PMNode; preserved: boolean } | null {
  const schema = getNoteSchema();
  if (!json || typeof json !== "object" || json.type !== "doc") return null;
  const mapped = mapNode(schema, json, false);
  if (!mapped.node.content?.length) mapped.node.content = [{ type: "paragraph" }];
  const node = checked(schema, mapped.node);
  return node ? { node, preserved: mapped.preserved } : null;
}

/** Brings any document JSON (editor output, parser output) into a valid, checked node. */
export function docToNode(doc: JSONContent | null | undefined): PMNode {
  const schema = getNoteSchema();
  const loaded = loadJson(doc ?? null);
  if (loaded) return loaded.node;
  if (doc && doc.type === "doc") {
    return schema.nodeFromJSON(docFromPlainText(textOfJson(doc)));
  }
  return schema.nodeFromJSON(emptyDoc());
}

function textOfJson(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const inner = (node.content ?? []).map(textOfJson);
  return node.type === "doc" ? inner.filter(Boolean).join("\n") : inner.join("");
}

/** Returns a valid copy of `doc` (placeholders kept). */
export function normalizeDoc(doc: JSONContent | null | undefined): JSONContent {
  return docToNode(doc).toJSON() as JSONContent;
}

/** The inverse of loadDoc's placeholder mapping: what gets stored in rawContent. */
export function toStoredDoc(doc: JSONContent): JSONContent {
  return restore(doc as Json) ?? emptyDoc();
}

function restore(node: Json): JSONContent | null {
  if (node.type === UNKNOWN_BLOCK || node.type === UNKNOWN_INLINE) {
    return (node.attrs?.json as JSONContent | undefined) ?? null;
  }
  const out: JSONContent = { ...node };
  if (node.marks?.length) {
    const marks: NonNullable<JSONContent["marks"]> = [];
    for (const mark of node.marks) {
      if (mark.type === UNKNOWN_MARKS) marks.push(...((mark.attrs?.marks as NonNullable<JSONContent["marks"]>) ?? []));
      else marks.push(mark);
    }
    out.marks = marks;
  }
  if (node.content) {
    const children: JSONContent[] = [];
    node.content.forEach((child, index) => {
      const next = node.content?.[index + 1];
      const isPadding =
        child.type === "paragraph" &&
        !child.content?.length &&
        next?.type === UNKNOWN_BLOCK &&
        next.attrs?.padded === true;
      if (isPadding) return;
      const restored = restore(child as Json);
      if (restored) children.push(restored);
    });
    out.content = children;
    if (!children.length) delete out.content;
  }
  return out;
}
