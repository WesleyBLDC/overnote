/** The few rules the fixtures and the end-to-end flows cannot reach cheaply. */
import { describe, expect, it } from "vitest";
import {
  buildNoteContent,
  countCharacters,
  countWords,
  docToPlainText,
  fold,
  highlightMarkdownMatches,
  loadDoc,
  markdownToDoc,
} from "../src/index";

describe("text rules", () => {
  it("folds case and diacritics", () => {
    expect(fold("Crème BRÛLÉE Ǆ")).toBe("creme brulee dz");
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
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hi", marks: [{ type: "highlight" }] },
            { type: "mention", attrs: { id: "u1" } },
          ],
        },
        {
          type: "list",
          attrs: { kind: "bullet", order: null, checked: false, collapsed: false },
          content: [{ type: "embed" }],
        },
      ],
    };
    const saved = JSON.parse(buildNoteContent(loadDoc(JSON.stringify(stored), "")).rawContent);
    expect(saved).toEqual(stored);
    expect(loadDoc("{broken", "a\nb").content?.[0]?.content?.map((n) => n.type)).toEqual(["text", "hardBreak", "text"]);
  });
});

describe("search highlighting", () => {
  const hl = highlightMarkdownMatches;

  it("leaves code, link destinations, URLs, and block markers alone", () => {
    expect(hl("Replay the play", "play")).toBe("Re**play** the **play**");
    expect(hl("anything", "  ")).toBe("anything");
    const md = [
      "# Plan",
      "- [ ] plan `plan()`",
      "[plan](https://plan.dev/plan) and https://x.dev/plan",
      "```",
      "plan",
      "```",
      "> 1. plan",
    ].join("\n");
    expect(hl(md, "plan")).toBe(
      [
        "# **Plan**",
        "- [ ] **plan** `plan()`",
        "[**plan**](https://plan.dev/plan) and https://x.dev/plan",
        "```",
        "plan",
        "```",
        "> 1. **plan**",
      ].join("\n"),
    );
    expect(hl("- [ ] task", "[ ]")).toBe("- [ ] task");
  });

  it("skips matches that would break emphasis", () => {
    expect(hl("a **bold word** here", "word")).toBe("a **bold word** here");
    expect(hl("*it* after", "it")).toBe("***it*** after");
    expect(hl("file.md and a.md", ".md")).toBe("file.md and a.md");
    expect(hl("see .md files", ".md")).toBe("see **.md** files");
  });
});
