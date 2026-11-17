/** The slash menu trigger and items. */
import type { EditorState } from "@tiptap/pm/state";
import { BLOCK_LABELS } from "./commands";

export interface SlashQuery {
  /** Position of the `/`. */
  from: number;
  to: number;
  query: string;
}

/** The active `/query` before the caret, if the rules allow a menu there. */
export function slashQueryAt(state: EditorState): SlashQuery | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const parent = $from.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  if ($from.marks().some((mark) => mark.type.name === "code")) return null;
  const before = parent.textBetween(0, $from.parentOffset, "\n", "\n");
  const slash = before.lastIndexOf("/");
  if (slash === -1) return null;
  const prev = before[slash - 1];
  if (slash > 0 && prev !== " " && prev !== " ") return null;
  const query = before.slice(slash + 1);
  if (query.startsWith(" ") || query.includes("  ") || query.includes("\n")) return null;
  return { from: $from.start() + slash, to: $from.pos, query };
}

export type SlashSection = "Text" | "Lists" | "Blocks";

export interface SlashItem {
  id: SlashFormat;
  title: string;
  section: SlashSection;
  /** The Markdown that makes the same block as you type, shown on the right of the row. */
  markdown: string;
  /** The row's tile: a short glyph, or "check" for the checklist icon. */
  glyph: string;
  keywords: string[];
}

type SlashFormat = keyof typeof BLOCK_LABELS;

const item = (
  id: SlashFormat,
  section: SlashSection,
  glyph: string,
  markdown: string,
  keywords: string[],
): SlashItem => ({
  id,
  title: BLOCK_LABELS[id],
  section,
  glyph,
  markdown,
  keywords,
});

/** Blocks only: inline marks live on the format island and their shortcuts. */
export const SLASH_ITEMS: readonly SlashItem[] = [
  item("paragraph", "Text", "T", "", ["paragraph", "body", "plain"]),
  item("h1", "Text", "H1", "#", ["heading 1", "h1"]),
  item("h2", "Text", "H2", "##", ["heading 2", "h2"]),
  item("h3", "Text", "H3", "###", ["heading 3", "h3"]),
  item("bullet", "Lists", "•", "-", ["bullet", "unordered"]),
  item("ordered", "Lists", "1.", "1.", ["ordered"]),
  item("task", "Lists", "check", "[ ]", ["todo", "task", "checkbox"]),
  item("blockquote", "Blocks", "\u201d", ">", ["blockquote"]),
  item("codeBlock", "Blocks", "{}", "```", ["pre", "snippet"]),
  item("divider", "Blocks", "\u2014", "---", ["rule", "line", "separator", "hr"]),
];

/** Fuzzy subsequence score; higher is better, -1 means no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let last = -1;
  for (const char of q) {
    const index = t.indexOf(char, last + 1);
    if (index === -1) return -1;
    score += index === last + 1 ? 3 : 1;
    if (index === 0 || t[index - 1] === " ") score += 2;
    last = index;
  }
  if (t.startsWith(q)) score += 5;
  return score;
}

/** Items matching the query, best first; with an empty query, all items in menu order. */
export function filterSlashItems(query: string): SlashItem[] {
  const trimmed = query.trim();
  if (!trimmed) return [...SLASH_ITEMS];
  const threshold = Math.max(2, trimmed.length * 1.5);
  return SLASH_ITEMS.map((item, index) => {
    const scores = [item.title, ...item.keywords].map((text) => fuzzyScore(trimmed, text));
    const exact = trimmed.length > 3 && item.title.toLowerCase() === trimmed.toLowerCase();
    return { item, index, score: Math.max(...scores) + (exact ? 100 : 0) };
  })
    .filter((entry) => entry.score >= threshold)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
