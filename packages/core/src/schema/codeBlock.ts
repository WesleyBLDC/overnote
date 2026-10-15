/** Code block behavior from spec/editor.md section 9, applied to any CodeBlock based extension. */
import { textblockTypeInputRule, type Node } from "@tiptap/core";
import type { CodeBlockOptions } from "@tiptap/extension-code-block";

export const FENCE_BACKTICK = /^```([a-z+#-]+)?[\s\n]$/;
export const FENCE_TILDE = /^~~~([a-z+#-]+)?[\s\n]$/;

/** Enter stays in the block; ⇧Enter, ⌘Enter, and ↓ at the end exit; fences accept `c++`, `c#`, `objective-c`. */
export function extendCodeBlock<O extends CodeBlockOptions, S>(base: Node<O, S>): Node<O, S> {
  return base
    .extend({
      addInputRules() {
        return [FENCE_BACKTICK, FENCE_TILDE].map((find) =>
          textblockTypeInputRule({
            find,
            type: this.type,
            getAttributes: (match) => ({ language: match[1] ?? null }),
          }),
        );
      },
      addKeyboardShortcuts() {
        const parent = this.parent?.() ?? {};
        return {
          ...parent,
          "Shift-Enter": () => this.editor.isActive(this.name) && this.editor.commands.exitCode(),
          "Mod-Enter": () => this.editor.isActive(this.name) && this.editor.commands.exitCode(),
          Tab: () => this.editor.isActive(this.name) && this.editor.commands.insertContent("\t"),
          "Shift-Tab": () => {
            if (!this.editor.isActive(this.name)) return false;
            const { state, view } = this.editor;
            const { $from } = state.selection;
            const text = $from.parent.textContent;
            const lineStart = text.lastIndexOf("\n", $from.parentOffset - 1) + 1;
            const removable = /^(\t| {1,2})/.exec(text.slice(lineStart))?.[0].length ?? 0;
            if (removable > 0) view.dispatch(state.tr.delete($from.start() + lineStart, $from.start() + lineStart + removable));
            return true;
          },
          "Mod-a": () => {
            const { state } = this.editor;
            const { $from, $to } = state.selection;
            if ($from.parent.type !== this.type || !$from.sameParent($to)) return false;
            const start = $from.start();
            const end = $from.end();
            if (state.selection.from === start && state.selection.to === end) return false;
            return this.editor.commands.setTextSelection({ from: start, to: end });
          },
        };
      },
    })
    .configure({
      exitOnTripleEnter: false,
      exitOnArrowDown: true,
      defaultLanguage: null,
      enableTabIndentation: false,
    } as Partial<O>);
}
