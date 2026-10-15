/**
 * prosemirror-flat-list wrapped as a Tiptap node: one `list` node per item with attrs
 * kind (bullet | ordered | task | toggle), order, checked, and collapsed.
 * This file is DOM-free; the editor adds the rendering, click, and clipboard plugins.
 */
import { Extension, Node } from "@tiptap/core";
import type { Schema } from "@tiptap/pm/model";
import type { DOMOutputSpec } from "@tiptap/pm/model";
import { createParseDomRules, listToDOM } from "prosemirror-flat-list";

export const LIST = "list";
export const LIST_KINDS = ["bullet", "ordered", "task", "toggle"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/** Deepest text block depth Tab may indent into (five list levels in a plain note). */
export const MAX_LIST_TEXT_DEPTH = 6;

const noParse = () => null;

export const FlatList = Node.create({
  name: LIST,
  group: "flatList block",
  content: "(paragraph|list) block*",

  addAttributes() {
    return {
      kind: { default: "bullet", rendered: false, parseHTML: noParse },
      order: { default: null, rendered: false, parseHTML: noParse },
      checked: { default: false, rendered: false, parseHTML: noParse },
      collapsed: { default: false, rendered: false, parseHTML: noParse },
    };
  },

  parseHTML() {
    return [...createParseDomRules()];
  },

  renderHTML({ node }) {
    return listToDOM({ node }) as DOMOutputSpec;
  },

  onBeforeCreate() {
    markListSplittable(this.editor.schema);
  },
});

/** Spec fields Tiptap's node config has no slot for. */
export const FlatListSchemaFields = Extension.create({
  name: "flatListSchemaFields",
  extendNodeSchema(extension) {
    if (extension.name !== LIST) return {};
    return { definingForContent: true, definingAsContext: false };
  },
});

/**
 * Tiptap rebuilds attribute specs without extra fields, so the `splittable` flag that
 * prosemirror-flat-list relies on is restored here, once per schema.
 */
export function markListSplittable(schema: Schema): Schema {
  const kind = schema.nodes[LIST]?.spec.attrs?.kind as { splittable?: boolean } | undefined;
  if (kind) kind.splittable = true;
  return schema;
}
