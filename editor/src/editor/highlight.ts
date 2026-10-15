/**
 * Code block syntax highlighting that stays smooth while typing: decorations are recomputed right away
 * when a note loads, a code block appears or disappears, or its language changes, but typing only
 * maps the existing decorations and schedules one fresh pass after a short pause.
 */
import { findChildren } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { NoteLowlight } from "./lowlight";

export const HIGHLIGHT_DELAY_MS = 200;

interface HastNode {
  value?: string;
  children?: HastNode[];
  properties?: { className?: string[] };
}

function flatten(nodes: HastNode[], classes: string[] = []): { text: string; classes: string[] }[] {
  return nodes.flatMap((node) => {
    const next = [...classes, ...(node.properties?.className ?? [])];
    return node.children ? flatten(node.children, next) : [{ text: node.value ?? "", classes: next }];
  });
}

function highlightDoc(doc: PMNode, name: string, lowlight: NoteLowlight): DecorationSet {
  const decorations: Decoration[] = [];
  for (const block of findChildren(doc, (node) => node.type.name === name)) {
    const language = (block.node.attrs.language as string | null) ?? null;
    const text = block.node.textContent;
    const tree = language && lowlight.registered(language) ? lowlight.highlight(language, text) : lowlight.highlightAuto(text);
    let from = block.pos + 1;
    for (const run of flatten(tree.children as HastNode[])) {
      const to = from + run.text.length;
      if (run.classes.length) decorations.push(Decoration.inline(from, to, { class: run.classes.join(" ") }));
      from = to;
    }
  }
  return DecorationSet.create(doc, decorations);
}

function countBlocks(doc: PMNode, name: string): number {
  return findChildren(doc, (node) => node.type.name === name).length;
}

/** Plain typing (replace steps) is debounced; anything structural highlights at once. */
function needsImmediate(tr: Transaction, name: string, before: PMNode): boolean {
  if (tr.getMeta("bnLoad")) return true;
  if (tr.steps.some((step) => !(step instanceof ReplaceStep))) return true;
  return countBlocks(before, name) !== countBlocks(tr.doc, name);
}

export function debouncedHighlightPlugin(options: { name: string; lowlight: NoteLowlight; delay?: number }): Plugin {
  const { name, lowlight, delay = HIGHLIGHT_DELAY_MS } = options;
  const refreshKey = new PluginKey<DecorationSet>("noteHighlight");
  return new Plugin<DecorationSet>({
    key: refreshKey,
    state: {
      init: (_config, state) => highlightDoc(state.doc, name, lowlight),
      apply(tr, set, oldState) {
        if (tr.getMeta(refreshKey)) return highlightDoc(tr.doc, name, lowlight);
        if (!tr.docChanged) return set;
        if (needsImmediate(tr, name, oldState.doc)) return highlightDoc(tr.doc, name, lowlight);
        return set.map(tr.mapping, tr.doc);
      },
    },
    view() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        update(view, previous) {
          if (view.state.doc === previous.doc || countBlocks(view.state.doc, name) === 0) return;
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(refreshKey, true).setMeta("addToHistory", false));
          }, delay);
        },
        destroy() {
          clearTimeout(timer);
        },
      };
    },
    props: {
      decorations: (state) => refreshKey.getState(state),
    },
  });
}
