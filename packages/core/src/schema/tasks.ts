/** Task toggling on flat-list `list` nodes of kind task. */
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { LIST } from "./flatList";

export interface FoundTask {
  pos: number;
  node: PMNode;
}

const isTask = (node: PMNode): boolean => node.type.name === LIST && node.attrs.kind === "task";

/** The innermost task around the caret, or every task whose first line the selection touches. */
export function tasksInSelection(state: EditorState): FoundTask[] {
  const { from, to, empty, $from } = state.selection;
  if (empty) {
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth);
      if (isTask(node)) return [{ pos: $from.before(depth), node }];
      if (node.type.name === LIST) return [];
    }
    return [];
  }
  const found: FoundTask[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!isTask(node)) return true;
    const first = node.firstChild;
    const firstStart = pos + 1;
    const firstEnd = firstStart + (first?.nodeSize ?? 0);
    if (firstEnd > from && firstStart < to) found.push({ pos, node });
    return true;
  });
  return found;
}

function withDescendants(item: FoundTask): FoundTask[] {
  const found: FoundTask[] = [item];
  item.node.descendants((node, offset) => {
    if (isTask(node)) found.push({ pos: item.pos + 1 + offset, node });
    return true;
  });
  return found;
}

/**
 * Sets every given task to the opposite of the first one's state.
 * With `nested`, their nested tasks get the same new state.
 */
export function toggleTasks(state: EditorState, items: FoundTask[], nested: boolean): Transaction | null {
  const first = items[0];
  if (!first) return null;
  const checked = first.node.attrs.checked !== true;
  const targets = nested ? items.flatMap(withDescendants) : items;
  const tr = state.tr;
  const seen = new Set<number>();
  for (const target of targets) {
    if (seen.has(target.pos)) continue;
    seen.add(target.pos);
    tr.setNodeAttribute(target.pos, "checked", checked);
  }
  return tr;
}

export function taskAt(state: EditorState, pos: number): FoundTask | null {
  const node = state.doc.nodeAt(pos);
  return node && isTask(node) ? { pos, node } : null;
}
