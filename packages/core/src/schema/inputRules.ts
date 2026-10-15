/**
 * Input rules that need list awareness, plus the link rules (spec/editor.md section 2).
 * Tiptap's own rules cover headings outside lists, quotes, code fences, marks, and typography.
 */
import { Extension, InputRule } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { createListInputRuleHandler, type ListAttributes } from "prosemirror-flat-list";
import { normalizeLinkHref } from "../link";
import { LIST } from "./flatList";

type ChainState = EditorState;

/** Runs a prosemirror style handler on a scratch state and copies its steps into Tiptap's transaction. */
function applyScratch(state: ChainState, build: (scratch: EditorState) => Transaction | null): boolean {
  const scratch = EditorState.create({ doc: state.doc, selection: state.selection });
  const result = build(scratch);
  if (!result || result.steps.length === 0) return false;
  const tr = state.tr;
  for (const step of result.steps) tr.step(step);
  tr.setSelection(TextSelection.create(tr.doc, result.selection.from, result.selection.to));
  return true;
}

function listRule(find: RegExp, getAttrs: (match: RegExpMatchArray) => ListAttributes): InputRule {
  const handler = createListInputRuleHandler(({ match }) => getAttrs(match));
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      const applied = applyScratch(state, (scratch) => {
        const $from = scratch.doc.resolve(range.from);
        // A heading becomes a paragraph first so it can be wrapped in a list item.
        if ($from.parent.type.name === "heading") {
          const paragraph = scratch.schema.nodes.paragraph;
          if (!paragraph) return null;
          const tr = scratch.tr.setBlockType($from.before(), $from.after(), paragraph);
          const converted = scratch.apply(tr);
          const result = handler(converted, match, range.from, range.to);
          if (!result) return null;
          for (const step of result.steps) tr.step(step);
          return tr.setSelection(TextSelection.create(tr.doc, result.selection.from));
        }
        return handler(scratch, match, range.from, range.to);
      });
      return applied ? undefined : null;
    },
  });
}

/** `# ` at the start of a list item's first paragraph lifts the line out as a heading. */
function headingInListRule(): InputRule {
  return new InputRule({
    find: /^(#{1,3})\s$/,
    handler: ({ state, range, match }) => {
      const $from = state.doc.resolve(range.from);
      const depth = $from.depth;
      if (depth < 2) return null;
      const item = $from.node(depth - 1);
      if (item.type.name !== LIST || $from.index(depth - 1) !== 0) return null;
      const heading = state.schema.nodes.heading;
      if (!heading) return null;
      const level = match[1]?.length ?? 1;
      const paragraph = $from.parent;
      const tr = state.tr;
      const textStart = $from.start();
      const kept = paragraph.content.cut(range.to - textStart);
      const rest: PMNode[] = [];
      item.forEach((child, _offset, index) => {
        if (index > 0) rest.push(child);
      });
      const itemStart = $from.before(depth - 1);
      tr.replaceWith(itemStart, itemStart + item.nodeSize, [heading.create({ level }, kept), ...rest]);
      tr.setSelection(TextSelection.create(tr.doc, itemStart + 1));
      return undefined;
    },
  });
}

/** `---`, `___ `, or `*** ` in a list item's first paragraph replaces the whole item with a rule. */
function ruleInListRule(): InputRule {
  return new InputRule({
    find: /^(?:---|—-|___\s|\*\*\*\s)$/,
    handler: ({ state, range }) => {
      const $from = state.doc.resolve(range.from);
      const depth = $from.depth;
      if (depth < 2) return null;
      const item = $from.node(depth - 1);
      if (item.type.name !== LIST || $from.index(depth - 1) !== 0) return null;
      const hr = state.schema.nodes.horizontalRule;
      const paragraph = state.schema.nodes.paragraph;
      if (!hr || !paragraph) return null;
      const itemStart = $from.before(depth - 1);
      const tr = state.tr;
      tr.replaceWith(itemStart, itemStart + item.nodeSize, [hr.create(), paragraph.create()]);
      tr.setSelection(TextSelection.create(tr.doc, itemStart + 2));
      return undefined;
    },
  });
}

function linkRule(find: RegExp, labelIndex: number, hrefIndex: number): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      const link = state.schema.marks.link;
      const label = match[labelIndex];
      const href = normalizeLinkHref(match[hrefIndex] ?? "");
      if (!link || !label || !href) return null;
      const $from = state.doc.resolve(range.from);
      if ($from.parent.type.spec.code) return null;
      const marks = $from.marks().filter((mark) => mark.type !== link);
      const tr = state.tr;
      tr.replaceWith(range.from, range.to, state.schema.text(label, [...marks, link.create({ href })]));
      tr.removeStoredMark(link);
      return undefined;
    },
  });
}

export const NoteInputRules = Extension.create({
  name: "noteInputRules",
  priority: 1000,
  addInputRules() {
    return [
      headingInListRule(),
      ruleInListRule(),
      listRule(/^\s?([*-])\s$/, () => ({ kind: "bullet", collapsed: false })),
      listRule(/^\s?(\d+)\.\s$/, (match) => {
        const order = Number.parseInt(match[1] ?? "1", 10);
        return { kind: "ordered", collapsed: false, order: order >= 2 ? order : null };
      }),
      listRule(/^\s?(?:\[([\sxX]?)\]|【([\sxX]?)】)\s$/, (match) => {
        const mark = match[1] ?? match[2] ?? "";
        return { kind: "task", collapsed: false, checked: mark === "x" || mark === "X" };
      }),
      linkRule(/\[([^\]\n]+)\]\(([^)\s]+)\)$/, 1, 2),
      linkRule(/\(([^)\n]+)\)\[([^\]\s]+)\]$/, 1, 2),
    ];
  },
});
