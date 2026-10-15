/** Inline HTML with ProseMirror style mark nesting: adjacent runs share their common leading marks. */
import type { Mark, Node as PMNode } from "@tiptap/pm/model";

export function escapeHtml(text: string, quotes = false): string {
  const out = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return quotes ? out.replace(/"/g, "&quot;") : out;
}

export interface InlineHtmlOptions {
  /** Mark names, outermost first; marks not listed are not rendered. */
  order: readonly string[];
  /** Opening tag for a mark. */
  open(mark: Mark): string;
  close(mark: Mark): string;
  quotes: boolean;
}

export function inlineHtml(block: PMNode, options: InlineHtmlOptions): string {
  let out = "";
  let active: Mark[] = [];
  const sorted = (marks: readonly Mark[]) =>
    marks
      .filter((mark) => options.order.includes(mark.type.name))
      .sort((a, b) => options.order.indexOf(a.type.name) - options.order.indexOf(b.type.name));
  const closeTo = (keep: number) => {
    for (let i = active.length - 1; i >= keep; i--) {
      const mark = active[i];
      if (mark) out += options.close(mark);
    }
    active = active.slice(0, keep);
  };
  block.forEach((node) => {
    const marks = node.isText ? sorted(node.marks) : [];
    let keep = 0;
    while (keep < active.length && keep < marks.length && marks[keep]?.eq(active[keep] as Mark)) keep++;
    closeTo(keep);
    for (const mark of marks.slice(keep)) {
      out += options.open(mark);
      active.push(mark);
    }
    if (node.isText) out += escapeHtml(node.text ?? "", options.quotes);
    else if (node.type.name === "hardBreak") out += "<br>";
  });
  closeTo(0);
  return out;
}

const SIMPLE_TAGS: Record<string, string> = { bold: "strong", italic: "em", strike: "s", underline: "u", code: "code" };

export function simpleOpen(mark: Mark): string {
  return `<${SIMPLE_TAGS[mark.type.name] ?? "span"}>`;
}

export function simpleClose(mark: Mark): string {
  return mark.type.name === "link" ? "</a>" : `</${SIMPLE_TAGS[mark.type.name] ?? "span"}>`;
}
