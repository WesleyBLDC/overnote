/** Formatting actions shared by the slash menu, the format bar, and the Format action. */
import { toggleListKind, type ListKind } from "@overnote/core";
import type { Editor } from "@tiptap/core";
import { liftTarget } from "@tiptap/pm/transform";

export type FormatId =
  | "h1"
  | "h2"
  | "h3"
  | "bold"
  | "italic"
  | "strike"
  | "underline"
  | "code"
  | "link"
  | "codeBlock"
  | "blockquote"
  | "ordered"
  | "bullet"
  | "task"
  | "paragraph";

function toggleList(editor: Editor, kind: ListKind): boolean {
  return toggleListKind(kind)(editor.state, editor.view.dispatch, editor.view);
}

/** Lifts the caret's block out of any list so it can be quoted. */
function liftOutOfList(editor: Editor): void {
  const { state, view } = editor;
  const { $from, $to } = state.selection;
  const range = $from.blockRange($to, (node) => node.type.name !== "list" && node.type.name !== "paragraph");
  if (!range) return;
  const target = liftTarget(range);
  if (target !== null && target !== undefined && $from.node(range.depth + 1)?.type.name === "list") {
    view.dispatch(state.tr.lift(range, target));
  }
}

export function runFormat(editor: Editor, id: FormatId, openLink: () => void): boolean {
  const chain = editor.chain().focus();
  switch (id) {
    case "h1":
    case "h2":
    case "h3":
      return chain.toggleHeading({ level: Number(id.slice(1)) as 1 | 2 | 3 }).run();
    case "paragraph":
      return chain.setParagraph().run();
    case "bold":
      return chain.toggleBold().run();
    case "italic":
      return chain.toggleItalic().run();
    case "strike":
      return chain.toggleStrike().run();
    case "underline":
      return chain.toggleUnderline().run();
    case "code":
      return chain.toggleCode().run();
    case "codeBlock":
      return chain.toggleCodeBlock().run();
    case "blockquote":
      if (!editor.isActive("blockquote")) liftOutOfList(editor);
      return editor.chain().focus().toggleBlockquote().run();
    case "ordered":
      editor.commands.focus();
      return toggleList(editor, "ordered");
    case "bullet":
      editor.commands.focus();
      return toggleList(editor, "bullet");
    case "task":
      editor.commands.focus();
      return toggleList(editor, "task");
    case "link":
      openLink();
      return true;
  }
}

export function isFormatActive(editor: Editor, id: FormatId): boolean {
  switch (id) {
    case "h1":
    case "h2":
    case "h3":
      return editor.isActive("heading", { level: Number(id.slice(1)) });
    case "ordered":
    case "bullet":
    case "task":
      return activeListKind(editor) === id;
    case "paragraph":
      return editor.isActive("paragraph");
    default:
      return editor.isActive(id);
  }
}

/** The kind of the innermost list item around the caret. */
export function activeListKind(editor: Editor): ListKind | null {
  const { selection, doc } = editor.state;
  // A whole document selection starts at depth 0; look at its first text position instead.
  const $from =
    selection.$from.depth === 0 ? doc.resolve(Math.min(selection.from + 1, doc.content.size)) : selection.$from;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === "list") return node.attrs.kind as ListKind;
  }
  return null;
}
