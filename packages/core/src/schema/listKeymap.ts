/** List keys from spec/editor.md section 8 and the list toggles from section 7. */
import { Extension } from "@tiptap/core";
import type { Command } from "@tiptap/pm/state";
import {
  backspaceCommand,
  createDedentListCommand,
  createIndentListCommand,
  createMoveListCommand,
  createToggleListCommand,
  deleteCommand,
  enterCommand,
} from "prosemirror-flat-list";
import { LIST, MAX_LIST_TEXT_DEPTH, type ListKind } from "./flatList";
import { tasksInSelection, toggleTasks } from "./tasks";

const indent = createIndentListCommand();
const dedent = createDedentListCommand();
const moveUp = createMoveListCommand("up");
const moveDown = createMoveListCommand("down");

/** ⌃⌘↑ / ⌃⌘↓ as plain commands, for the ⌘K actions. */
export function moveListItem(direction: "up" | "down"): Command {
  return direction === "up" ? moveUp : moveDown;
}

export function toggleListKind(kind: ListKind): Command {
  return createToggleListCommand({ kind });
}

export const NoteListKeymap = Extension.create({
  name: "noteListKeymap",
  priority: 900,

  addKeyboardShortcuts() {
    const run = (command: Command) => () => command(this.editor.state, this.editor.view.dispatch, this.editor.view);
    const inCode = () => this.editor.isActive("codeBlock");
    const toggle = (nested: boolean) => () => {
      const { state, view } = this.editor;
      const tr = toggleTasks(state, tasksInSelection(state), nested);
      if (!tr) return false;
      view.dispatch(tr);
      return true;
    };
    return {
      Enter: run(enterCommand),
      Backspace: run(backspaceCommand),
      Delete: run(deleteCommand),
      Tab: () => {
        if (inCode()) return false;
        const { $from } = this.editor.state.selection;
        if ($from.depth >= MAX_LIST_TEXT_DEPTH) return true;
        // Only an item with a previous sibling item can be nested under it.
        for (let depth = $from.depth; depth > 0; depth--) {
          if ($from.node(depth).type.name !== LIST) continue;
          const index = $from.index(depth - 1);
          const previous = index > 0 ? $from.node(depth - 1).child(index - 1) : null;
          if (previous?.type.name !== LIST) return true;
          break;
        }
        run(indent)();
        return true;
      },
      "Shift-Tab": () => {
        if (inCode()) return false;
        run(dedent)();
        return true;
      },
      "Mod-Enter": () => (inCode() ? false : toggle(false)()),
      "Shift-Mod-Enter": () => (inCode() ? false : toggle(true)()),
      "Ctrl-Mod-ArrowUp": run(moveUp),
      "Ctrl-Mod-ArrowDown": run(moveDown),
      "Mod-Shift-7": run(toggleListKind("ordered")),
      "Mod-Shift-8": run(toggleListKind("bullet")),
      "Mod-Shift-9": run(toggleListKind("task")),
      "Mod-Alt-0": () => this.editor.commands.setParagraph(),
    };
  },
});
