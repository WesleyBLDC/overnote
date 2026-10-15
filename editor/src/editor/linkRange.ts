/** Choosing the range for the link popover (spec/editor.md section 6). */
import { normalizeLinkHref } from "@better-notes/core";
import type { EditorState } from "@tiptap/pm/state";

export interface LinkTarget {
  from: number;
  to: number;
  mode: "view" | "edit";
  href: string;
}

/** The word under the caret: a run of non-whitespace characters, or the word just before the caret. */
export function wordAt(state: EditorState): { from: number; to: number } | null {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return null;
  const text = $from.parent.textBetween(0, $from.parent.content.size, "\n", "￼");
  const offset = $from.parentOffset;
  let start = offset;
  let end = offset;
  while (start > 0 && !/\s|￼/.test(text[start - 1] ?? "")) start--;
  while (end < text.length && !/\s|￼/.test(text[end] ?? "")) end++;
  if (start === end) return null;
  const base = $from.start();
  return { from: base + start, to: base + end };
}

/** The single link covering the whole range, if any. */
export function linkCovering(state: EditorState, from: number, to: number): { from: number; to: number; href: string } | null {
  const type = state.schema.marks.link;
  if (!type) return null;
  let href: string | null = null;
  let same = true;
  state.doc.nodesBetween(from, Math.max(to, from + 1), (node) => {
    if (!node.isText) return true;
    const mark = node.marks.find((m) => m.type === type);
    const value = mark ? String(mark.attrs.href) : null;
    if (href === null && value !== null) href = value;
    if (value === null || value !== href) same = false;
    return false;
  });
  if (!same || href === null) return null;
  // Expand to the full extent of that link.
  const $from = state.doc.resolve(from);
  const parent = $from.parent;
  const base = $from.start();
  let start = from - base;
  let end = to - base;
  parent.forEach((child, offset) => {
    const has = child.marks.some((m) => m.type === type && m.attrs.href === href);
    if (!has) return;
    const childEnd = offset + child.nodeSize;
    if (childEnd >= start && offset <= end) {
      start = Math.min(start, offset);
      end = Math.max(end, childEnd);
    }
  });
  return { from: base + start, to: base + end, href };
}

export function chooseLinkTarget(state: EditorState): LinkTarget | null {
  let { from, to } = state.selection;
  if (from === to) {
    const word = wordAt(state);
    if (!word) return null;
    ({ from, to } = word);
  }
  const existing = linkCovering(state, from, to);
  if (existing) return { ...existing, mode: "view" };
  const selected = state.doc.textBetween(from, to, " ");
  return { from, to, mode: "edit", href: normalizeLinkHref(selected) ? selected.trim() : "" };
}
