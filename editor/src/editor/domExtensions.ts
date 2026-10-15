/**
 * DOM-only editor behavior layered on core's headless extensions: list rendering and clicks,
 * ⌘ click on links and nested tasks, paste rules, the clipboard format, and code block chrome.
 */
import {
  docToClipboard,
  looksLikeMarkdown,
  looksLikeUrl,
  normalizeLinkHref,
  parsePastedText,
  plainTextToDoc,
  taskAt,
  toggleTasks,
} from "@better-notes/core";
import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { createListEventPlugin, createListRenderingPlugin, createSafariInputMethodWorkaroundPlugin } from "prosemirror-flat-list";

export interface DomOptions {
  /** A link should open in the system browser. */
  onOpenLink: (href: string) => void;
  /** A plain click on a link: show the popover in view mode. */
  onLinkClick: (from: number, to: number) => void;
  /** True once after ⇧⌘V: the paste is inserted as plain text. A function, so Tiptap's option merge keeps it shared. */
  takePlainPaste: () => boolean;
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

function pastePlugin(options: DomOptions): Plugin {
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

        if (plain && options.takePlainPaste()) {
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
          else options.onLinkClick(range.from, range.to);
          return true;
        },
      },
    },
  });
}

export const NoteDomBehavior = Extension.create<DomOptions>({
  name: "noteDomBehavior",
  priority: 1100,
  addOptions() {
    return { onOpenLink: () => undefined, onLinkClick: () => undefined, takePlainPaste: () => false };
  },
  addProseMirrorPlugins() {
    return [
      clickPlugin(this.options),
      createListEventPlugin(),
      createListRenderingPlugin(),
      createSafariInputMethodWorkaroundPlugin(),
      pastePlugin(this.options),
      copyPlugin(),
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
