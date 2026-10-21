/** Shared list numbering and markers for Markdown, clipboard text, and HTML. */
import type { Node as PMNode } from "@tiptap/pm/model";
import { LIST } from "../schema/flatList";

export const isList = (node: PMNode | null | undefined): node is PMNode => node?.type.name === LIST;
export const isOrdered = (node: PMNode | null | undefined): boolean => isList(node) && node.attrs.kind === "ordered";

/**
 * Running numbers for the ordered items among `parent`'s children, by child index.
 * A stored order sets the counter; otherwise counter + 1; any other sibling resets it.
 */
export function orderNumbers(parent: PMNode): Map<number, number> {
  const numbers = new Map<number, number>();
  let counter = 0;
  parent.forEach((child, _offset, index) => {
    if (!isOrdered(child)) {
      counter = 0;
      return;
    }
    const stored = child.attrs.order;
    counter = typeof stored === "number" && Number.isFinite(stored) ? stored : counter + 1;
    numbers.set(index, counter);
  });
  return numbers;
}

/**
 * The marker text the editor shows for each ordered item, by document position.
 * A run of ordered siblings counts up from its first item's stored order, or from 1; any other sibling ends the run.
 * An item nested directly in an ordered item carries its parent's number path, so the items under 3 read 3.1, 3.2, and
 * under those 3.1.1; a top level item reads "3.". An item under any other block (a bullet, a task, a quote) starts a new path.
 * A list whose first child is another list shows no marker, as prosemirror-flat-list renders it, so it gets none here.
 */
export function orderedMarkerLabels(doc: PMNode): Map<number, string> {
  const labels = new Map<number, string>();
  const visit = (parent: PMNode, start: number, path: readonly number[]) => {
    let counter: number | null = null;
    parent.forEach((child, offset) => {
      const pos = start + offset;
      let childPath: readonly number[] = [];
      if (isOrdered(child) && !isList(child.firstChild)) {
        const stored = child.attrs.order;
        counter = counter === null ? (typeof stored === "number" && Number.isFinite(stored) ? stored : 1) : counter + 1;
        childPath = [...path, counter];
        labels.set(pos, childPath.length === 1 ? `${counter}.` : childPath.join("."));
      } else {
        counter = null;
      }
      if (child.isBlock && !child.isTextblock && child.childCount) visit(child, pos + 1, childPath);
    });
  };
  visit(doc, 0, []);
  return labels;
}

export interface ListMarker {
  /** The marker text written before the item's first line, without a trailing space. */
  marker: string;
  /** Indentation for the item's children: the width of the marker plus one space. */
  width: number;
}

export type MarkerStyle = "markdown" | "clipboard";

export function listMarker(item: PMNode, number: number | undefined, style: MarkerStyle): ListMarker {
  if (item.attrs.kind === "ordered") {
    const marker = `${number ?? 1}.`;
    return { marker, width: marker.length + 1 };
  }
  if (item.attrs.kind === "task") {
    const box = item.attrs.checked ? "[x]" : "[ ]";
    return { marker: style === "clipboard" ? `- ${box} ` : `- ${box}`, width: 2 };
  }
  return { marker: "-", width: 2 };
}

/** Markers for every list child of `parent`, by child index. */
export function listMarkers(parent: PMNode, style: MarkerStyle): (ListMarker | null)[] {
  const numbers = orderNumbers(parent);
  const out: (ListMarker | null)[] = [];
  parent.forEach((child, _offset, index) => {
    out[index] = isList(child) ? listMarker(child, numbers.get(index), style) : null;
  });
  return out;
}
