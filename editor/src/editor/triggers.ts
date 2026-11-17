/**
 * The `/` slash menu and `:` emoji picker triggers, on Tiptap's Suggestion utility: it owns when a trigger
 * is active, Escape and its dismissal, input method composition, and routing keys to the open menu.
 * Our own matchers (slash.ts, emoji.ts) keep the trigger rules, and the React menus render and pick.
 */
import { Extension, type Editor } from "@tiptap/core";
import type { ResolvedPos } from "@tiptap/pm/model";
import { PluginKey } from "@tiptap/pm/state";
import { Suggestion } from "@tiptap/suggestion";
import { emojiQueryAt } from "./emoji";
import { slashQueryAt } from "./slash";

/** The text a trigger covers, from the trigger character to the caret, and the query typed after it. */
export interface TriggerMatch {
  from: number;
  to: number;
  query: string;
}

type Which = "slash" | "emoji";

export interface TriggerOptions {
  /** The trigger opened or its query changed (a match), or it closed (null). */
  onChange: Record<Which, (match: TriggerMatch | null) => void>;
}

/** A key while a trigger is open; true when its menu used it. Escape never arrives: Suggestion closes the trigger. */
type KeyHandler = (event: KeyboardEvent) => boolean;

interface TriggerStorage {
  /** Set by the open menu at runtime (setTriggerKeys), so the extension list never changes. */
  keys: Record<Which, KeyHandler | null>;
}

const SLASH_KEY = new PluginKey("slashTrigger");
const EMOJI_KEY = new PluginKey("emojiTrigger");

function trigger(
  editor: Editor,
  char: string,
  pluginKey: PluginKey,
  match: ($from: ResolvedPos) => TriggerMatch | null,
  onChange: (match: TriggerMatch | null) => void,
  onKeyDown: KeyHandler,
) {
  const report = ({ range, query }: { range: { from: number; to: number }; query: string }) =>
    onChange({ from: range.from, to: range.to, query });
  return Suggestion({
    editor,
    char,
    pluginKey,
    decorationClass: "trigger-query",
    findSuggestionMatch: ({ $position }) => {
      const found = match($position);
      return found ? { range: { from: found.from, to: found.to }, query: found.query, text: char + found.query } : null;
    },
    render: () => ({
      onStart: report,
      onUpdate: report,
      onExit: () => onChange(null),
      onKeyDown: ({ event }) => event.key !== "Escape" && onKeyDown(event),
    }),
  });
}

/** Routes keys for an open trigger to its menu; a menu that is not open passes null. */
export function setTriggerKeys(editor: Editor, keys: Record<Which, KeyHandler | null>): void {
  (editor.storage as unknown as Record<string, TriggerStorage>)[NoteTriggers.name]!.keys = keys;
}

export const NoteTriggers = Extension.create<TriggerOptions, TriggerStorage>({
  name: "noteTriggers",
  // Ahead of the list and editor keymaps, so an open menu gets Enter, Tab, and the arrows first.
  priority: 1200,
  addStorage() {
    return { keys: { slash: null, emoji: null } };
  },
  addProseMirrorPlugins() {
    const keysFor =
      (which: Which): KeyHandler =>
      (event) =>
        this.storage.keys[which]?.(event) ?? false;
    return [
      trigger(this.editor, ":", EMOJI_KEY, emojiQueryAt, this.options.onChange.emoji, keysFor("emoji")),
      trigger(this.editor, "/", SLASH_KEY, slashQueryAt, this.options.onChange.slash, keysFor("slash")),
    ];
  },
});
