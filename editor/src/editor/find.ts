/** Find and replace: case-insensitive literal matching inside text blocks. */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface Match {
  from: number;
  to: number;
}

/**
 * Find's one source of truth, kept in the editor state: the term, the active match, and the matches with their
 * highlights. Matches are recomputed only when the document or the term changes, never on a plain redraw.
 */
export interface FindState {
  term: string;
  /** Index into `matches`, or -1 when there are none. */
  active: number;
  matches: Match[];
  decorations: DecorationSet;
}

/** What a transaction may change: the term, the active match, or both (findTransaction). */
export interface FindMeta {
  term?: string;
  active?: number;
}

const EMPTY: FindState = { term: "", active: -1, matches: [], decorations: DecorationSet.empty };

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

function decorate(doc: PMNode, matches: Match[], active: number): DecorationSet {
  if (!matches.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, { class: index === active ? "find-match is-active" : "find-match" }),
    ),
  );
}

/** The next find state after a transaction: pure, so it is unit tested. */
export function nextFindState(value: FindState, tr: Transaction): FindState {
  const meta = tr.getMeta(findKey) as FindMeta | undefined;
  if (!meta && !tr.docChanged) return value;
  const term = meta?.term ?? value.term;
  if (!term) return EMPTY;
  const matches = term !== value.term || tr.docChanged ? findMatches(tr.doc, term) : value.matches;
  const wanted = meta?.active ?? value.active;
  const active = matches.length ? Math.min(Math.max(wanted, 0), matches.length - 1) : -1;
  if (matches === value.matches && active === value.active) return value;
  return { term, active, matches, decorations: decorate(tr.doc, matches, active) };
}

/** Reads find's state from an editor state. */
export const findState = (state: EditorState): FindState => findKey.getState(state) ?? EMPTY;

/** A transaction that changes find's term or active match, kept out of undo history. */
export function findTransaction(state: EditorState, meta: FindMeta): Transaction {
  return state.tr.setMeta(findKey, meta).setMeta("addToHistory", false);
}

export const FindHighlight = Extension.create({
  name: "findHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: { init: () => EMPTY, apply: (tr, value) => nextFindState(value, tr) },
        props: { decorations: (state) => findState(state).decorations },
      }),
    ];
  },
});
