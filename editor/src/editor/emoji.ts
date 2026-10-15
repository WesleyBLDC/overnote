/** Emoji picker data and trigger. The emoji database loads lazily. */
import type { EditorState } from "@tiptap/pm/state";

export interface EmojiEntry {
  emoji: string;
  label: string;
  tags: string[];
  group: number | null;
  order: number;
}

export interface EmojiQuery {
  from: number;
  to: number;
  query: string;
}

/** `:` at the start of a text block or after a space, followed by the query up to the caret. */
export function emojiQueryAt(state: EditorState): EmojiQuery | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const parent = $from.parent;
  if (!parent.isTextblock || parent.type.spec.code) return null;
  if ($from.marks().some((mark) => mark.type.name === "code")) return null;
  const before = parent.textBetween(0, $from.parentOffset, "\n", "￼");
  const match = /(?:^|[ \u00a0])(:([^\s:]*))$/.exec(before);
  if (!match || match[1] === undefined) return null;
  const start = before.length - match[1].length;
  return { from: $from.start() + start, to: $from.pos, query: normalizeEmojiQuery(match[2] ?? "") };
}

/** Strips colons, trims, lowercases, trims non-alphanumerics, and joins inner runs with underscores. */
export function normalizeEmojiQuery(raw: string): string {
  return raw
    .replace(/^:+|:+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "_");
}

export const DEFAULT_QUICK = ["😂", "❤️", "🤣", "✅", "🥺", "👍"];

export const CATEGORIES: ReadonlyArray<{ name: string; groups: (number | null)[] }> = [
  { name: "Smileys & People", groups: [0, 1] },
  { name: "Animals & Nature", groups: [3] },
  { name: "Food & Drink", groups: [4] },
  { name: "Activity", groups: [6] },
  { name: "Travel & Places", groups: [5] },
  { name: "Objects", groups: [7] },
  { name: "Symbols", groups: [8] },
  { name: "Flags", groups: [9] },
  { name: "Other Symbols", groups: [null] },
];

interface RawEmoji {
  unicode: string;
  label: string;
  tags?: string[];
  group?: number;
  order?: number;
}

let database: Promise<EmojiEntry[]> | null = null;

export function loadEmoji(): Promise<EmojiEntry[]> {
  database ??= import("emojibase-data/en/compact.json").then((module) =>
    (module.default as RawEmoji[])
      .filter((raw) => raw.group !== 2)
      .map((raw) => ({
        emoji: raw.unicode,
        label: raw.label,
        tags: raw.tags ?? [],
        group: raw.group ?? null,
        order: raw.order ?? Number.MAX_SAFE_INTEGER,
      }))
      .sort((a, b) => a.order - b.order),
  );
  return database;
}

/** Matches by label words and tags; label word prefixes rank first. */
export function searchEmoji(entries: EmojiEntry[], query: string): EmojiEntry[] {
  const terms = query.split("_").filter(Boolean);
  if (!terms.length) return [];
  const scored: { entry: EmojiEntry; score: number }[] = [];
  for (const entry of entries) {
    const words = entry.label.toLowerCase().split(/[\s:,-]+/);
    let score = 0;
    for (const term of terms) {
      const inLabel = words.some((word) => word.startsWith(term));
      const inTags = entry.tags.some((tag) => tag.startsWith(term));
      if (!inLabel && !inTags) {
        score = -1;
        break;
      }
      score += inLabel ? 3 : 1;
      if (words[0]?.startsWith(term)) score += 2;
    }
    if (score > 0) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.entry.order - b.entry.order).map((s) => s.entry);
}

const FREQUENT_KEY = "overnote.emoji.frequent";

/** Per viewer usage counts; storage can be unavailable, so every access is guarded. */
export function frequentEmoji(): string[] {
  try {
    const counts = JSON.parse(localStorage.getItem(FREQUENT_KEY) ?? "{}") as Record<string, number>;
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([emoji]) => emoji);
  } catch {
    return [];
  }
}

export function recordEmojiUse(emoji: string): void {
  try {
    const counts = JSON.parse(localStorage.getItem(FREQUENT_KEY) ?? "{}") as Record<string, number>;
    counts[emoji] = (counts[emoji] ?? 0) + 1;
    localStorage.setItem(FREQUENT_KEY, JSON.stringify(counts));
  } catch {
    // Frequent emoji are a convenience; ignore storage failures.
  }
}

export function quickEmoji(): string[] {
  const out: string[] = [];
  for (const emoji of [...frequentEmoji(), ...DEFAULT_QUICK]) {
    if (!out.includes(emoji)) out.push(emoji);
    if (out.length === 6) break;
  }
  return out;
}
