/** The editor's extension list: core's headless extensions plus DOM-only behavior. */
import { createHeadlessExtensions } from "@overnote/core";
import { Extension, type AnyExtension, type Editor } from "@tiptap/core";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Dropcursor, Gapcursor, Placeholder } from "@tiptap/extensions";
import { createCodeBlockView, type CodeBlockViewOptions } from "./codeBlockView";
import { NoteDomBehavior, linkRangeAt, type DomOptions } from "./domExtensions";
import { FindHighlight } from "./find";
import { debouncedHighlightPlugin } from "./highlight";
import type { NoteLowlight } from "./lowlight";

export interface EditorExtensionOptions extends DomOptions, CodeBlockViewOptions {
  lowlight: NoteLowlight;
  /** ⌘L: open the link popover. */
  onLinkShortcut: (editor: Editor) => void;
}

function editorKeymap(options: EditorExtensionOptions) {
  return Extension.create({
    name: "noteEditorKeymap",
    priority: 800,
    addKeyboardShortcuts() {
      return {
        "Mod-l": () => {
          options.onLinkShortcut(this.editor);
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

/**
 * Code block syntax highlighting. The stock lowlight highlighter re-runs on every keystroke inside a
 * code block; this one waits for a pause (highlight.ts).
 */
function codeBlockHighlight(name: string, lowlight: NoteLowlight) {
  return Extension.create({
    name: "codeBlockHighlight",
    addProseMirrorPlugins() {
      return [debouncedHighlightPlugin({ name, lowlight })];
    },
  });
}

export function createEditorExtensions(options: EditorExtensionOptions): AnyExtension[] {
  // The stock code block (the same node and schema CodeBlockLowlight extends) with our chrome. Highlighting
  // comes from a separate extension, so no inherited highlighter has to be found and removed.
  const codeBlock = CodeBlock.extend({
    addNodeView() {
      return createCodeBlockView(options);
    },
  });
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
    codeBlockHighlight(codeBlock.name, options.lowlight),
    FindHighlight,
    NoteDomBehavior.configure(options),
    editorKeymap(options),
  ];
}
