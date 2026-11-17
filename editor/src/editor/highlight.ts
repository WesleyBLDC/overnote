/**
 * Code block syntax highlighting that stays smooth while typing, on Tiptap's Decorations API: decorations
 * are recomputed right away when a note loads, a code block appears or disappears, or its language
 * changes, but typing inside a code block only maps the existing decorations and schedules one fresh
 * pass after a short pause. Edits outside every code block leave the decorations alone.
 * Tiptap's CodeBlockLowlight re-highlights every code block on each keystroke inside any of them.
 */
import { Decoration, Extension, findChildren } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { AttrStep, ReplaceStep } from "@tiptap/pm/transform";
import type { NoteLowlight } from "./lowlight";

const HIGHLIGHT_DELAY_MS = 200;

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

function highlightDoc(doc: PMNode, name: string, lowlight: NoteLowlight): Decoration[] {
  const decorations: Decoration[] = [];
  for (const block of findChildren(doc, (node) => node.type.name === name)) {
    const language = (block.node.attrs.language as string | null) ?? null;
    const text = block.node.textContent;
    const tree =
      language && lowlight.registered(language) ? lowlight.highlight(language, text) : lowlight.highlightAuto(text);
    let from = block.pos + 1;
    for (const run of flatten(tree.children as HastNode[])) {
      const to = from + run.text.length;
      if (run.classes.length) decorations.push(Decoration.Inline(from, to, { class: run.classes.join(" ") }));
      from = to;
    }
  }
  return decorations;
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

/** What a document change means for the highlighting: nothing, a pass right away, or one after a pause. */
function changeKind(tr: Transaction, name: string, before: PMNode): "none" | "now" | "later" {
  if (!tr.docChanged) return "none";
  const sameCount = countBlocks(before, name) === countBlocks(tr.doc, name);
  if (!touchesBlock(tr, name) && sameCount) return "none";
  return needsImmediate(tr, name, before) ? "now" : "later";
}

interface HighlightStorage {
  /** Text was typed in a code block since the last full pass. */
  stale: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function CodeBlockHighlight(options: { name: string; lowlight: NoteLowlight; delay?: number }) {
  const { name, lowlight, delay = HIGHLIGHT_DELAY_MS } = options;
  return Extension.create<unknown, HighlightStorage>({
    name: "codeBlockHighlight",
    addStorage() {
      return { stale: false, timer: undefined };
    },
    addDecorations() {
      return {
        create: ({ state }) => highlightDoc(state.doc, name, lowlight),
        shouldUpdate: ({ tr, oldState }) => changeKind(tr, name, oldState.doc) === "now",
      };
    },
    // After the decorations were built: track whether typing left them stale, and debounce one fresh pass.
    onTransaction({ transaction, appendedTransactions }) {
      const changes = [transaction, ...appendedTransactions].filter((tr) => tr.docChanged);
      if (!changes.length) return;
      for (const tr of changes) {
        const kind = changeKind(tr, name, tr.before);
        if (kind === "now") this.storage.stale = false;
        if (kind === "later") this.storage.stale = true;
      }
      clearTimeout(this.storage.timer);
      if (!this.storage.stale) return;
      this.storage.timer = setTimeout(() => {
        if (this.editor.isDestroyed) return;
        this.storage.stale = false;
        this.editor.commands.updateDecorations(this.name);
      }, delay);
    },
    onDestroy() {
      clearTimeout(this.storage.timer);
    },
  });
}
