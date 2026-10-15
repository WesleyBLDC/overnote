/** The few rules the fixtures and the end-to-end flows cannot reach cheaply. */
import { describe, expect, it } from "vitest";
import { buildNoteContent, countCharacters, countWords, deriveTitle, displayTitle, docToPlainText, fold, loadDoc, markdownToDoc } from "../src/index";

describe("text rules", () => {
  it("folds case and diacritics", () => {
    expect(fold("Crème BRÛLÉE Ǆ")).toBe("creme brulee dz");
  });

  it("derives and displays titles", () => {
    expect(deriveTitle({ type: "doc", content: [{ type: "paragraph" }, { type: "paragraph", content: [{ type: "text", text: "  Second " }] }] })).toBe("Second");
    expect(deriveTitle(markdownToDoc("Line one  \nLine two"))).toBe("Line one");
    expect(displayTitle({ title: "", text: "\n first \nsecond" })).toBe("first");
    expect(displayTitle({ title: " ", text: "" })).toBe("Untitled");
  });

  it("counts graphemes and words", () => {
    expect(countCharacters(docToPlainText(markdownToDoc("a\n\nb")))).toBe(4);
    expect(countCharacters("👨‍👩‍👧‍👦")).toBe(1);
    expect(countWords("Hi, there! 🙂 ok")).toBe(3);
  });
});

describe("stored content", () => {
  it("keeps unknown nodes and marks through a save and falls back to text", () => {
    const stored = {
      type: "doc",
      content: [
        { type: "callout", attrs: { tone: "warm" } },
        { type: "paragraph", content: [{ type: "text", text: "hi", marks: [{ type: "highlight" }] }, { type: "mention", attrs: { id: "u1" } }] },
        { type: "list", attrs: { kind: "bullet", order: null, checked: false, collapsed: false }, content: [{ type: "embed" }] },
      ],
    };
    const saved = JSON.parse(buildNoteContent(loadDoc(JSON.stringify(stored), "")).rawContent);
    expect(saved).toEqual(stored);
    expect(loadDoc("{broken", "a\nb").content?.[0]?.content?.map((n) => n.type)).toEqual(["text", "hardBreak", "text"]);
  });
});
