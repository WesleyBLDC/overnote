/**
 * Code block syntax highlighting that stays smooth while typing: decorations are recomputed right away
 * when a note loads, a code block appears or disappears, or its language changes, but typing inside a
 * code block only maps the existing decorations and schedules one fresh pass after a short pause.
 * Edits outside every code block leave the decorations alone.
 */
import { findChildren } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { AttrStep, ReplaceStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { NoteLowlight } from "./lowlight";

const HIGHLIGHT_DELAY_MS = 200;

interface HastNode {
  value?: string;
  children?: HastNode[];
  properties?: { className?: string[] };
}

/** The decorations plus whether a debounced pass is still owed for text typed since the last one. */
interface HighlightState {
  decorations: DecorationSet;
  stale: boolean;
}

function flatten(nodes: HastNode[], classes: string[] = []): { text: string; classes: string[] }[] {
  return nodes.flatMap((node) => {
    const next = [...classes, ...(node.properties?.className ?? [])];
    return node.children ? flatten(node.children, next) : [{ text: node.value ?? "", classes: next }];
  });
}

function highlightDoc(doc: PMNode, name: string, lowlight: NoteLowlight): HighlightState {
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
  return { decorations: DecorationSet.create(doc, decorations), stale: false };
}

function countBlocks(doc: PMNode, name: string): number {
  return findChildren(doc, (node) => node.type.name === name).length;
}

/** Whether any step of `tr` changed something inside a code block (positions are read in `tr.doc`). */
function touchesBlock(tr: Transaction, name: string): boolean {
  const inBlock = (from: number, to: number) => {
    let found = false;
    tr.doc.nodesBetween(from, to, (node) => {
      if (node.type.name === name) found = true;
      return !found;
    });
    return found;
  };
  return tr.steps.some((step, index) => {
    const rest = tr.mapping.slice(index + 1);
    // Attribute steps (a language change) move no ranges, so they are looked up by position.
    if (step instanceof AttrStep) {
      const pos = rest.map(step.pos);
      return inBlock(pos, pos + 1);
    }
    let touched = false;
    step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      touched ||= inBlock(rest.map(newStart, -1), rest.map(newEnd, 1));
    });
    return touched;
  });
}

/** Plain typing (replace steps) is debounced; anything structural highlights at once. */
function needsImmediate(tr: Transaction, name: string, before: PMNode): boolean {
  if (tr.getMeta("bnLoad")) return true;
  if (tr.steps.some((step) => !(step instanceof ReplaceStep))) return true;
  return countBlocks(before, name) !== countBlocks(tr.doc, name);
}

export function debouncedHighlightPlugin(options: { name: string; lowlight: NoteLowlight; delay?: number }): Plugin {
  const { name, lowlight, delay = HIGHLIGHT_DELAY_MS } = options;
  const refreshKey = new PluginKey<HighlightState>("noteHighlight");
  return new Plugin<HighlightState>({
    key: refreshKey,
    state: {
      init: (_config, state) => highlightDoc(state.doc, name, lowlight),
      apply(tr, previous, oldState) {
        if (tr.getMeta(refreshKey)) return highlightDoc(tr.doc, name, lowlight);
        if (!tr.docChanged) return previous;
        const mapped = previous.decorations.map(tr.mapping, tr.doc);
        if (!touchesBlock(tr, name) && countBlocks(oldState.doc, name) === countBlocks(tr.doc, name)) {
          return { decorations: mapped, stale: previous.stale };
        }
        if (needsImmediate(tr, name, oldState.doc)) return highlightDoc(tr.doc, name, lowlight);
        return { decorations: mapped, stale: true };
      },
    },
    view() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return {
        update(view, previous) {
          if (view.state.doc === previous.doc) return;
          clearTimeout(timer);
          if (!refreshKey.getState(view.state)?.stale) return;
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
      decorations: (state) => refreshKey.getState(state)?.decorations,
    },
  });
}
