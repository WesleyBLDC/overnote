/** Find and replace: case-insensitive literal matching inside text blocks. */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface Match {
  from: number;
  to: number;
}

export interface FindState {
  term: string;
  active: number;
}

export const findKey = new PluginKey<FindState>("noteFind");

/** All non-overlapping matches; inline nodes such as hard breaks are skipped, so a match may span one. */
export function findMatches(doc: PMNode, term: string): Match[] {
  const needle = term.toLocaleLowerCase();
  if (!needle) return [];
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    const positions: number[] = [];
    node.forEach((child, offset) => {
      if (!child.isText) return;
      const value = child.text ?? "";
      for (let i = 0; i < value.length; i++) {
        const lower = (value[i] ?? "").toLocaleLowerCase();
        for (let j = 0; j < lower.length; j++) positions.push(pos + 1 + offset + i);
        text += lower;
      }
    });
    let index = text.indexOf(needle);
    while (index !== -1) {
      const from = positions[index];
      const last = positions[index + needle.length - 1];
      if (from !== undefined && last !== undefined) matches.push({ from, to: last + 1 });
      index = text.indexOf(needle, index + needle.length);
    }
    return false;
  });
  return matches;
}

function replaceRange(tr: Transaction, match: Match, replacement: string): void {
  const marks = tr.doc.resolve(match.from + 1).marks();
  if (replacement) tr.replaceWith(match.from, match.to, tr.doc.type.schema.text(replacement, marks));
  else tr.delete(match.from, match.to);
}

/** Replaces one match and returns the transaction. */
export function replaceOne(state: EditorState, match: Match, replacement: string): Transaction {
  const tr = state.tr;
  replaceRange(tr, match, replacement);
  return tr;
}

/** Replaces every match in one transaction (one undo step). */
export function replaceAll(state: EditorState, term: string, replacement: string): Transaction | null {
  const matches = findMatches(state.doc, term);
  if (!matches.length) return null;
  const tr = state.tr;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    if (match) replaceRange(tr, match, replacement);
  }
  return tr;
}

export function selectMatch(state: EditorState, match: Match): Transaction {
  return state.tr.setSelection(TextSelection.create(state.doc, match.from, match.to)).scrollIntoView();
}

export const FindHighlight = Extension.create({
  name: "findHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ term: "", active: -1 }),
          apply: (tr, value) => tr.getMeta(findKey) ?? value,
        },
        props: {
          decorations(state) {
            const find = findKey.getState(state);
            if (!find?.term) return DecorationSet.empty;
            const matches = findMatches(state.doc, find.term);
            return DecorationSet.create(
              state.doc,
              matches.map((match, index) =>
                Decoration.inline(match.from, match.to, {
                  class: index === find.active ? "find-match is-active" : "find-match",
                }),
              ),
            );
          },
        },
      }),
    ];
  },
});
