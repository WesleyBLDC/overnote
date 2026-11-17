/**
 * The empty note's title line (SPEC §9): the first character typed into an entirely empty note makes that line the
 * note's title (Title, a level 1 heading), and ↩ then moves to the body. Characters that start a Markdown block, a
 * slash command, or an emoji (`/`, `#`, `-`, `>`, and so on) are left alone, so those keep working on the first line.
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

const BLOCK_STARTS = /^[/#\-*+>`[:|~]/u;

export const TitleLine = Extension.create({
  name: "titleLine",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("titleLine"),
        props: {
          handleTextInput(view, from, to, text) {
            const { doc, schema } = view.state;
            const first = doc.firstChild;
            if (doc.childCount !== 1 || first?.type.name !== "paragraph" || first.content.size > 0) return false;
            if (BLOCK_STARTS.test(text)) return false;
            const heading = schema.nodes.heading;
            if (!heading) return false;
            // One step: the line becomes the title and takes the character, so one undo removes both.
            view.dispatch(
              view.state.tr.setBlockType(0, first.nodeSize, heading, { level: 1 }).insertText(text, from, to),
            );
            return true;
          },
        },
      }),
    ];
  },
});
