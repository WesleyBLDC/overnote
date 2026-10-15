/** Plain text paste helpers (spec/editor.md 3.1, spec/serialization.md section 8). */
import type { JSONContent } from "@tiptap/core";
import { markdownToDoc } from "./markdown";

export const MAX_MARKDOWN_PASTE = 100_000;

const BLOCK_PATTERN =
  /^(?:#{1,6}[ \t]+\S|[ \t]*[-+*][ \t]+\[[ xX]\][ \t]|[ \t]*[-+*][ \t]+\S|[ \t]*\d+[.)][ \t]+\S|[ \t]*>|[ \t]*(?:```|~~~)|[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$|[ \t]*\|.*\|[ \t]*$)/m;
const BLOCK_TAGS = /<(?:h[1-6]|ul|ol|li|blockquote|pre|table|thead|tbody|tfoot|tr|td|th)[\s>/]/i;

/** True when the plain text has a block Markdown signal and the HTML flavor has no structure of its own. */
export function looksLikeMarkdown(plain: string, html?: string): boolean {
  if (!BLOCK_PATTERN.test(plain)) return false;
  return !(html && BLOCK_TAGS.test(html));
}

/** One paragraph per line, no formatting (⇧⌘V and very long text). */
export function plainTextToDoc(plain: string): JSONContent {
  const lines = plain.replace(/\r\n?/g, "\n").split("\n");
  return {
    type: "doc",
    content: lines.map((line) => (line ? { type: "paragraph", content: [{ type: "text", text: line }] } : { type: "paragraph" })),
  };
}

/** Pasted plain text as a document: Markdown in paste mode, or one paragraph per line when too long. */
export function parsePastedText(plain: string, _html?: string): JSONContent {
  if (plain.length > MAX_MARKDOWN_PASTE) return plainTextToDoc(plain);
  try {
    return markdownToDoc(plain, { mode: "paste" });
  } catch {
    return plainTextToDoc(plain);
  }
}
