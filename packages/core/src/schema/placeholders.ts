/**
 * Hidden placeholders that keep content this version does not understand.
 * They render nothing and are mapped back to the original JSON on save by toStoredDoc.
 */
import { Mark, Node } from "@tiptap/core";

export const UNKNOWN_BLOCK = "unknownBlock";
export const UNKNOWN_INLINE = "unknownInline";
export const UNKNOWN_MARKS = "unknownMarks";

export const UnknownBlock = Node.create({
  name: UNKNOWN_BLOCK,
  group: "block",
  atom: true,
  selectable: false,
  draggable: false,
  addAttributes() {
    return {
      json: { default: null, rendered: false },
      /** True when an empty padding paragraph was inserted before this placeholder. */
      padded: { default: false, rendered: false },
    };
  },
  parseHTML: () => [],
  renderHTML: () => ["div", { "data-unknown": "block", hidden: "", contenteditable: "false" }],
});

export const UnknownInline = Node.create({
  name: UNKNOWN_INLINE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,
  addAttributes() {
    return { json: { default: null, rendered: false } };
  },
  parseHTML: () => [],
  renderHTML: () => ["span", { "data-unknown": "inline", hidden: "", contenteditable: "false" }],
  renderText: () => "",
});

export const UnknownMarks = Mark.create({
  name: UNKNOWN_MARKS,
  inclusive: false,
  addAttributes() {
    return { marks: { default: [], rendered: false } };
  },
  parseHTML: () => [],
  renderHTML: () => ["span", {}, 0],
});
