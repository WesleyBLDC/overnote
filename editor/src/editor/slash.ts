/** The slash menu trigger and items. */
import type { EditorState } from "@tiptap/pm/state";

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

export type SlashSection = "Headings" | "Inline" | "Blocks" | "Lists";

export interface SlashItem {
  id: string;
  title: string;
  section: SlashSection;
  shortcut: string;
  keywords: string[];
}

export const SLASH_ITEMS: readonly SlashItem[] = [
  { id: "h1", title: "Heading 1", section: "Headings", shortcut: "⌥⌘1", keywords: ["title", "h1"] },
  { id: "h2", title: "Heading 2", section: "Headings", shortcut: "⌥⌘2", keywords: ["subtitle", "h2"] },
  { id: "h3", title: "Heading 3", section: "Headings", shortcut: "⌥⌘3", keywords: ["h3"] },
  { id: "bold", title: "Bold", section: "Inline", shortcut: "⌘B", keywords: ["strong"] },
  { id: "italic", title: "Italic", section: "Inline", shortcut: "⌘I", keywords: ["emphasis"] },
  { id: "strike", title: "Strikethrough", section: "Inline", shortcut: "⇧⌘S", keywords: ["strike"] },
  { id: "underline", title: "Underline", section: "Inline", shortcut: "⌘U", keywords: [] },
  { id: "code", title: "Code", section: "Inline", shortcut: "⌘E", keywords: ["inline"] },
  { id: "codeBlock", title: "Code Block", section: "Blocks", shortcut: "⌥⌘C", keywords: ["pre", "snippet"] },
  { id: "blockquote", title: "Blockquote", section: "Blocks", shortcut: "⇧⌘B", keywords: ["quote"] },
  { id: "ordered", title: "Ordered List", section: "Lists", shortcut: "⇧⌘7", keywords: ["numbered"] },
  { id: "bullet", title: "Bullet List", section: "Lists", shortcut: "⇧⌘8", keywords: ["unordered"] },
  { id: "task", title: "Task List", section: "Lists", shortcut: "⇧⌘9", keywords: ["todo", "check"] },
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
