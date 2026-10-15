/** The editor's extension list: core's headless extensions plus DOM-only behavior. */
import { createHeadlessExtensions } from "@overnote/core";
import { Extension, type AnyExtension } from "@tiptap/core";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { Dropcursor, Gapcursor, Placeholder } from "@tiptap/extensions";
import { createCodeBlockView, type CodeBlockViewOptions } from "./codeBlockView";
import { NoteDomBehavior, linkRangeAt, type DomOptions } from "./domExtensions";
import { FindHighlight } from "./find";
import { debouncedHighlightPlugin } from "./highlight";
import type { NoteLowlight } from "./lowlight";

export interface EditorExtensionOptions extends DomOptions, CodeBlockViewOptions {
  lowlight: NoteLowlight;
  /** ⌘L: open the link popover. */
  onLinkShortcut: () => void;
}

function editorKeymap(options: EditorExtensionOptions) {
  return Extension.create({
    name: "noteEditorKeymap",
    priority: 800,
    addKeyboardShortcuts() {
      return {
        "Mod-l": () => {
          options.onLinkShortcut();
          return true;
        },
        // ⌘↩ on a link opens it, after task toggling and code block exit had their chance.
        "Mod-Enter": () => {
          const range = linkRangeAt(this.editor.view, this.editor.state.selection.from);
          if (!range) return false;
          options.onOpenLink(range.href);
          return true;
        },
        "Mod-ArrowUp": () => {
          const first = this.editor.state.doc.firstChild;
          if (first?.type.name !== "list" || first.attrs.kind !== "task") return false;
          return this.editor.commands.setTextSelection(2);
        },
      };
    },
  });
}

export function createEditorExtensions(options: EditorExtensionOptions): AnyExtension[] {
  const codeBlock = CodeBlockLowlight.extend({
    addNodeView() {
      return createCodeBlockView(options);
    },
    /*
     * The stock highlighter re-runs on every keystroke inside a code block; ours waits for a pause.
     * Tiptap can resolve this.parent back to this same function when the node is extended again
     * (core's extendCodeBlock), so highlighters from any level are dropped before ours is added once.
     */
    addProseMirrorPlugins() {
      const isHighlighter = (plugin: unknown) => /^(lowlight|noteHighlight)\$/.test((plugin as { key: string }).key);
      const inherited = (this.parent?.() ?? []).filter((plugin) => !isHighlighter(plugin));
      return [...inherited, debouncedHighlightPlugin({ name: this.name, lowlight: options.lowlight })];
    },
  }).configure({ lowlight: options.lowlight, defaultLanguage: null });
  return [
    ...createHeadlessExtensions({ codeBlock }),
    Placeholder.configure({
      showOnlyWhenEditable: true,
      showOnlyCurrent: true,
      includeChildren: false,
      placeholder: ({ editor, node, pos }) => {
        if (pos !== 0) return "";
        if (node.type.name === "heading") return `Heading ${String(node.attrs.level)}`;
        if (node.type.name === "paragraph" && editor.state.doc.childCount === 1) return "Start writing…";
        return "";
      },
    }),
    Dropcursor.configure({ width: 2, class: "drop-cursor" }),
    Gapcursor,
    FindHighlight,
    NoteDomBehavior.configure(options),
    editorKeymap(options),
  ];
}
