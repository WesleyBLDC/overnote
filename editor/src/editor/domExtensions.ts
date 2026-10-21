/**
 * DOM-only editor behavior layered on core's headless extensions: list rendering and clicks,
 * ⌘ click on links and nested tasks, paste rules, the clipboard format, and code block chrome.
 */
import {
  docToClipboard,
  looksLikeMarkdown,
  looksLikeUrl,
  normalizeLinkHref,
  orderedMarkerLabels,
  parsePastedText,
  plainTextToDoc,
  taskAt,
  toggleTasks,
} from "@overnote/core";
import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { AttrStep } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  createListEventPlugin,
  createListRenderingPlugin,
  createSafariInputMethodWorkaroundPlugin,
} from "prosemirror-flat-list";

export interface DomOptions {
  /** A link should open in the system browser. */
  onOpenLink: (href: string) => void;
  /** A plain click on a link: show the popover in view mode. `state` is the editor state at the click. */
  onLinkClick: (from: number, to: number, state: EditorState) => void;
}

/** How long ⇧⌘V waits for the paste it announces. */
const PLAIN_PASTE_WINDOW_MS = 1000;

interface DomStorage {
  /** Until when the next paste is inserted as plain text (⇧⌘V), in Date.now() time. */
  plainPasteUntil: number;
}

function linkRangeAt(view: EditorView, pos: number): { from: number; to: number; href: string } | null {
  const link = view.state.schema.marks.link;
  if (!link) return null;
  const $pos = view.state.doc.resolve(pos);
  const parent = $pos.parent;
  let start = $pos.parentOffset;
  let end = start;
  const markAt = (offset: number) => {
    const child = parent.childAfter(offset).node;
    return child?.marks.find((mark) => mark.type === link) ?? null;
  };
  const mark = markAt(start) ?? (start > 0 ? markAt(start - 1) : null);
  if (!mark) return null;
  parent.forEach((child, offset) => {
    if (!mark.isInSet(child.marks)) return;
    const childEnd = offset + child.nodeSize;
    if (offset <= end && childEnd >= start) {
      start = Math.min(start, offset);
      end = Math.max(end, childEnd);
    }
  });
  const base = $pos.start();
  return { from: base + start, to: base + end, href: String(mark.attrs.href ?? "") };
}

function sliceFromDoc(schema: Schema, json: ReturnType<typeof parsePastedText>): Slice {
  const node = schema.nodeFromJSON(json);
  const content = node.content;
  // A single paragraph merges inline into the current block.
  if (content.childCount === 1 && content.firstChild?.type.name === "paragraph") {
    return new Slice(Fragment.from(content.firstChild), 1, 1);
  }
  return new Slice(content, 0, 0);
}

function pastePlugin(takePlainPaste: () => boolean): Plugin {
  return new Plugin({
    key: new PluginKey("notePaste"),
    props: {
      handlePaste(view, event) {
        const data = event.clipboardData;
        if (!data) return false;
        const plain = data.getData("text/plain");
        const html = data.getData("text/html");
        const uriList = data.getData("text/uri-list");
        const { state } = view;
        const schema = state.schema;
        if (state.selection.$from.parent.type.spec.code) return false;

        if (plain && takePlainPaste()) {
          view.dispatch(state.tr.replaceSelection(sliceFromDoc(schema, plainTextToDoc(plain))).scrollIntoView());
          return true;
        }

        const uri = uriList
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line && !line.startsWith("#"));
        const candidate = (uri ?? plain).trim();
        const link = schema.marks.link;
        if (link && candidate && looksLikeUrl(candidate)) {
          const href = normalizeLinkHref(candidate);
          if (href) {
            const { from, to, empty } = state.selection;
            const tr = state.tr;
            if (empty) {
              tr.insert(from, schema.text(candidate, [link.create({ href })]));
              tr.setSelection(TextSelection.create(tr.doc, from + candidate.length));
              tr.removeStoredMark(link);
            } else {
              tr.removeMark(from, to, link).addMark(from, to, link.create({ href }));
            }
            view.dispatch(tr.scrollIntoView());
            return true;
          }
        }

        if (plain && (looksLikeMarkdown(plain, html || undefined) || !html)) {
          view.dispatch(state.tr.replaceSelection(sliceFromDoc(schema, parsePastedText(plain, html))).scrollIntoView());
          return true;
        }
        return false;
      },
    },
  });
}

/** The positions just inside the first and last textblocks of `node` (at `pos`), where a text selection covering it starts and ends. */
function innerTextRange(node: PMNode, pos: number): { start: number; end: number } {
  let start = pos + 1;
  let end = pos + node.nodeSize - 1;
  for (let first = node; !first.isTextblock && first.firstChild; first = first.firstChild) start += 1;
  for (let last = node; !last.isTextblock && last.lastChild; last = last.lastChild) end -= 1;
  return { start, end };
}

/**
 * Marks every list fully inside a non-empty selection with in-selection, so the stylesheet can paint
 * the marker gutter that WebKit leaves blank (see editor.css). A decoration keeps stored content
 * untouched, and it only adds a class, so line boxes and the reported height never change.
 */
function listSelectionPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey("listSelection"),
    props: {
      decorations(state) {
        const { from, to, empty } = state.selection;
        if (empty) return DecorationSet.empty;
        const decorations: Decoration[] = [];
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name !== "list") return true;
          const inner = innerTextRange(node, pos);
          if (from <= inner.start && to >= inner.end)
            decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "in-selection" }));
          return true;
        });
        return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
      },
    },
  });
}

/**
 * Numbers ordered items with their parent's number path (3, 3.1, 3.1.1), which CSS counters cannot do
 * reliably across flat-list's nesting. The label goes on the item as data-list-marker for the stylesheet
 * to show; it is a decoration, so stored content and copies keep standard 1. numbering.
 */
function orderedMarkerPlugin(): Plugin {
  const key = new PluginKey<DecorationSet>("orderedMarkers");
  const build = (doc: PMNode) => {
    const decorations: Decoration[] = [];
    orderedMarkerLabels(doc).forEach((label, pos) => {
      decorations.push(Decoration.node(pos, pos + doc.nodeAt(pos)!.nodeSize, { "data-list-marker": label }));
    });
    return DecorationSet.create(doc, decorations);
  };
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => build(state.doc),
      apply: (tr, set) => (tr.docChanged ? build(tr.doc) : set),
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  });
}

/** List positions in `tr.doc` whose task went from unchecked to checked in this transaction. */
function newlyCheckedTasks(tr: Transaction, before: PMNode): number[] {
  const found = new Set<number>();
  const back = tr.mapping.invert();
  const consider = (node: PMNode, pos: number) => {
    if (node.type.name !== "list" || node.attrs.kind !== "task" || !node.attrs.checked) return;
    const old = before.nodeAt(back.map(pos));
    if (old && old.type === node.type && old.attrs.kind === "task" && !old.attrs.checked) found.add(pos);
  };
  tr.steps.forEach((step, index) => {
    const rest = tr.mapping.slice(index + 1);
    // Attribute steps (setNodeAttribute) change no ranges, so they are looked up by position.
    if (step instanceof AttrStep) {
      const pos = rest.map(step.pos);
      const node = tr.doc.nodeAt(pos);
      if (node) consider(node, pos);
      return;
    }
    step.getMap().forEach((_oldStart, _oldEnd, start, end) => {
      tr.doc.nodesBetween(rest.map(start, -1), rest.map(end, 1), (node, pos) => {
        consider(node, pos);
        return true;
      });
    });
  });
  return [...found];
}

/**
 * Checking a task re-creates its DOM (the node's attributes change), so a CSS transition cannot run.
 * This marks the items checked by the last edit with just-checked, which plays a one-time check
 * animation; the mark clears on the next edit, and loading a note starts without any.
 */
function taskCheckPlugin(): Plugin {
  const key = new PluginKey<DecorationSet>("taskCheck");
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set, oldState) {
        if (!tr.docChanged) return set.map(tr.mapping, tr.doc);
        if (tr.getMeta("bnLoad")) return DecorationSet.empty;
        const checked = newlyCheckedTasks(tr, oldState.doc);
        if (!checked.length) return DecorationSet.empty;
        return DecorationSet.create(
          tr.doc,
          checked.map((pos) => Decoration.node(pos, pos + tr.doc.nodeAt(pos)!.nodeSize, { class: "just-checked" })),
        );
      },
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  });
}

function copyPlugin(): Plugin {
  const write = (view: EditorView, event: ClipboardEvent, cut: boolean) => {
    const { selection } = view.state;
    if (selection.empty || !event.clipboardData) return false;
    const slice = selection.content();
    const flavors = docToClipboard({ ...slice.toJSON(), openStart: slice.openStart, openEnd: slice.openEnd });
    event.preventDefault();
    event.clipboardData.clearData();
    event.clipboardData.setData("text/plain", flavors.text);
    event.clipboardData.setData("text/html", flavors.html);
    if (cut) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"));
    return true;
  };
  return new Plugin({
    key: new PluginKey("noteCopy"),
    props: {
      handleDOMEvents: {
        copy: (view, event) => write(view, event, false),
        cut: (view, event) => write(view, event, true),
      },
    },
  });
}

function clickPlugin(options: DomOptions): Plugin {
  return new Plugin({
    key: new PluginKey("noteClicks"),
    props: {
      handleDOMEvents: {
        mousedown(view, event) {
          const target = event.target instanceof Element ? event.target : null;
          if (!target) return false;
          // ⌘ click on a task checkbox toggles the task and its nested tasks.
          const marker = target.closest(".list-marker-click-target");
          if (marker && event.metaKey) {
            const pos = view.posAtDOM(marker, -10, -10);
            const $pos = view.state.doc.resolve(pos);
            const found = taskAt(view.state, $pos.before($pos.depth));
            if (!found) return false;
            event.preventDefault();
            const tr = toggleTasks(view.state, [found], true);
            if (tr) view.dispatch(tr);
            return true;
          }
          return false;
        },
        click(view, event) {
          const target = event.target instanceof Element ? event.target : null;
          const anchor = target?.closest("a[href]");
          if (!anchor || !view.dom.contains(anchor)) return false;
          const pos = view.posAtDOM(anchor, 0);
          const range = linkRangeAt(view, pos + 1) ?? linkRangeAt(view, pos);
          event.preventDefault();
          if (!range) return true;
          if (event.metaKey) options.onOpenLink(range.href);
          else options.onLinkClick(range.from, range.to, view.state);
          return true;
        },
      },
    },
  });
}

export const NoteDomBehavior = Extension.create<DomOptions, DomStorage>({
  name: "noteDomBehavior",
  priority: 1100,
  addOptions() {
    return { onOpenLink: () => undefined, onLinkClick: () => undefined };
  },
  addStorage() {
    return { plainPasteUntil: 0 };
  },
  addKeyboardShortcuts() {
    return {
      // ⇧⌘V: the paste that follows is inserted as plain text. The key itself still pastes.
      "Mod-Shift-v": () => {
        this.storage.plainPasteUntil = Date.now() + PLAIN_PASTE_WINDOW_MS;
        return false;
      },
    };
  },
  addProseMirrorPlugins() {
    const takePlainPaste = () => {
      const plain = Date.now() <= this.storage.plainPasteUntil;
      this.storage.plainPasteUntil = 0;
      return plain;
    };
    return [
      clickPlugin(this.options),
      createListEventPlugin(),
      createListRenderingPlugin(),
      createSafariInputMethodWorkaroundPlugin(),
      pastePlugin(takePlainPaste),
      copyPlugin(),
      listSelectionPlugin(),
      orderedMarkerPlugin(),
      taskCheckPlugin(),
      new Plugin({
        key: new PluginKey("noFileDrop"),
        props: {
          handleDrop: (_view, event) => Boolean(event.dataTransfer?.files.length),
        },
      }),
    ];
  },
});

export { linkRangeAt };
