/**
 * Search highlighting for rendered Markdown (Search Notes detail pane): wraps matches of a query
 * in `**bold**` without breaking Markdown syntax. Matching uses the filter fold rule (case and
 * diacritic insensitive). No Tiptap import, so it lives in the light text entry.
 *
 * A match is wrapped only when doing so is safe:
 * - it sits outside code fences, code spans, link and image destinations, autolinks, bare URLs,
 *   HTML tags, entities, and block markers (quote, list, task, heading prefixes);
 * - it stays on one line and contains no Markdown syntax characters;
 * - it is not already inside strong emphasis;
 * - the inserted delimiters can open and close (CommonMark flanking rules).
 * Everything else is left untouched, so the original text is always preserved.
 */
import { fold } from "./fold";

const SYNTAX_CHARS = /[*_`~[\]\\<>|]/;
const BLOCK_PREFIX = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)?/;
/** A fence, also inside quotes and list items (any indentation, after `>` and list markers). */
const FENCE = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/;
const INLINE_PROTECTED = [
  /\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"\n]*")?\)/g, // link and image destinations: ](url "title")
  /\]\[[^\]\n]*\]/g, // reference labels
  /<[^<>\n]+>/g, // autolinks and HTML tags
  /\b(?:https?:\/\/|www\.)[^\s<>]*/gi, // bare URLs that renderers autolink
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, // bare email autolinks
  /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi, // entities
];

type Range = [start: number, end: number];

/** Folds code point by code point and maps every folded index back to its source code point. */
function foldWithMap(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;
  for (const char of text) {
    const piece = fold(char);
    for (let i = 0; i < piece.length; i++) {
      starts.push(index);
      ends.push(index + char.length);
    }
    folded += piece;
    index += char.length;
  }
  return { folded, starts, ends };
}

function foldQuery(query: string): string {
  let out = "";
  for (const char of query.trim()) out += fold(char);
  return out;
}

/** Code spans (backtick runs closed by a run of the same length) and the inline patterns above. */
function protectedInline(line: string): Range[] {
  const ranges: Range[] = [];
  const ticks = /`+/g;
  let open: RegExpExecArray | null;
  while ((open = ticks.exec(line))) {
    const run = open[0];
    const close = new RegExp(`(?<!\`)${run}(?!\`)`, "g");
    close.lastIndex = open.index + run.length;
    const end = close.exec(line);
    if (!end) {
      ticks.lastIndex = open.index + run.length;
      continue;
    }
    ranges.push([open.index, end.index + run.length]);
    ticks.lastIndex = end.index + run.length;
  }
  for (const pattern of INLINE_PROTECTED) {
    pattern.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = pattern.exec(line))) {
      if (hit[0].length === 0) {
        pattern.lastIndex++;
        continue;
      }
      ranges.push([hit.index, hit.index + hit[0].length]);
    }
  }
  return ranges;
}

const inside = (ranges: Range[], start: number, end: number) => ranges.some(([a, b]) => start < b && end > a);

/** True when `**` delimiters before `at` (outside protected ranges) leave strong emphasis open. */
function insideStrong(line: string, at: number, ranges: Range[]): boolean {
  const runs = /(?<!\\)(\*{2,}|_{2,})/g;
  let open = false;
  let hit: RegExpExecArray | null;
  while ((hit = runs.exec(line)) && hit.index < at) {
    if (inside(ranges, hit.index, hit.index + hit[0].length)) continue;
    open = !open;
  }
  return open;
}

const isSpace = (char: string | undefined) => char === undefined || /\s/u.test(char);
const isPunct = (char: string | undefined) => char !== undefined && /[\p{P}\p{S}]/u.test(char);

/** CommonMark flanking: can `**` open before `first` (preceded by `before`) and close after `last`? */
function delimitersWork(before: string | undefined, first: string, last: string, after: string | undefined): boolean {
  const opens = !isSpace(first) && (!isPunct(first) || isSpace(before) || isPunct(before));
  const closes = !isSpace(last) && (!isPunct(last) || isSpace(after) || isPunct(after));
  return opens && closes;
}

function highlightLine(line: string, query: string): string {
  const prefix = BLOCK_PREFIX.exec(line)?.[0].length ?? 0;
  const ranges = protectedInline(line);
  ranges.push([0, prefix]);
  const { folded, starts, ends } = foldWithMap(line);
  let out = "";
  let copied = 0;
  let from = 0;
  for (;;) {
    const hit = folded.indexOf(query, from);
    if (hit === -1) break;
    from = hit + query.length;
    let start = starts[hit] ?? 0;
    let end = ends[hit + query.length - 1] ?? start;
    // Delimiters cannot sit next to whitespace inside the span, so trim it off.
    while (start < end && /\s/u.test(line[start] ?? "")) start++;
    while (end > start && /\s/u.test(line[end - 1] ?? "")) end--;
    if (start >= end || start < copied) continue;
    const text = line.slice(start, end);
    if (SYNTAX_CHARS.test(text) || inside(ranges, start, end) || insideStrong(line, start, ranges)) continue;
    const first = String.fromCodePoint(text.codePointAt(0) ?? 0);
    const last = Array.from(text).at(-1) ?? "";
    const before = Array.from(line.slice(0, start)).at(-1);
    const after = line.slice(end).length ? String.fromCodePoint(line.slice(end).codePointAt(0) ?? 0) : undefined;
    if (!delimitersWork(before, first, last, after)) continue;
    out += `${line.slice(copied, start)}**${text}**`;
    copied = end;
  }
  return out + line.slice(copied);
}

/** Wraps the query's matches in `**` wherever that keeps the Markdown intact; returns the input when there is nothing to do. */
export function highlightMarkdownMatches(markdown: string, query: string): string {
  const needle = foldQuery(query);
  if (!needle || !markdown) return markdown;
  const lines = markdown.split("\n");
  let fence: string | null = null;
  return lines
    .map((line) => {
      const match = FENCE.exec(line);
      const marker = match?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length && !match?.[2]?.trim()) fence = null;
        return line;
      }
      if (marker && !(marker[0] === "`" && match?.[2]?.includes("`"))) {
        fence = marker;
        return line;
      }
      return highlightLine(line, needle);
    })
    .join("\n");
}
