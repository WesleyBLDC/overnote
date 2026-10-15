/**
 * The headless Tiptap extension list: schema, input rules, and keymaps. It runs in Node with no DOM
 * and is the schema source of truth. The editor adds DOM-only extensions on top.
 */
import { getSchema, type AnyExtension } from "@tiptap/core";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Typography } from "@tiptap/extension-typography";
import type { Schema } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { extendCodeBlock } from "./schema/codeBlock";
import { FlatList, FlatListSchemaFields, markListSplittable } from "./schema/flatList";
import { NoteInputRules } from "./schema/inputRules";
import { NoteListKeymap } from "./schema/listKeymap";
import { NoteCode, NoteLink } from "./schema/marks";
import { UnknownBlock, UnknownInline, UnknownMarks } from "./schema/placeholders";

export const HEADING_LEVELS = [1, 2, 3] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];

export interface ExtensionOptions {
  /**
   * Replaces the default code block, for example with CodeBlockLowlight in the editor.
   * It is passed through the same customizations, so the schema stays identical.
   */
  codeBlock?: AnyExtension;
}

export function createHeadlessExtensions(options: ExtensionOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [...HEADING_LEVELS] },
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      codeBlock: false,
      code: false,
      link: false,
      trailingNode: false,
      dropcursor: false,
      gapcursor: false,
      undoRedo: { depth: 100, newGroupDelay: 1 },
    }),
    extendCodeBlock((options.codeBlock as typeof CodeBlock | undefined) ?? CodeBlock),
    NoteCode,
    NoteLink,
    FlatList,
    FlatListSchemaFields,
    NoteListKeymap,
    NoteInputRules,
    Typography,
    UnknownBlock,
    UnknownInline,
    UnknownMarks,
  ];
}

/** The default headless extension list (contract section 7). */
export const headlessExtensions: AnyExtension[] = createHeadlessExtensions();

let cachedSchema: Schema | undefined;

/** The ProseMirror schema built from `headlessExtensions`, cached after the first call. */
export function getNoteSchema(): Schema {
  cachedSchema ??= markListSplittable(getSchema(headlessExtensions));
  return cachedSchema;
}
