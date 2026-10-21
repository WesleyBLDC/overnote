/** The few rules the fixtures and the end-to-end flows cannot reach cheaply. */
import { describe, expect, it } from "vitest";
import {
  buildNoteContent,
  countCharacters,
  countWords,
  docToMarkdown,
  docToPlainText,
  fold,
  highlightMarkdownMatches,
  loadDoc,
  markdownToDoc,
  mergeDocs,
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

describe("merging an outside change into unsaved edits", () => {
  const md = (text: string) => markdownToDoc(text);
  const merged = (base: string, local: string, remote: string) => {
    const result = mergeDocs(md(base), md(local), md(remote));
    return { ...result, markdown: docToMarkdown(result.doc) };
  };

  it("applies changes to different blocks from both sides", () => {
    expect(merged("A\n\nB\n\nC", "A mine\n\nB\n\nC", "A\n\nB\n\nC\n\nD")).toEqual({
      doc: md("A mine\n\nB\n\nC\n\nD"),
      markdown: "A mine\n\nB\n\nC\n\nD",
      conflicted: false,
      matchesRemote: false,
    });
    // Adjacent blocks, list items, and an insertion before a changed block are independent too.
    expect(merged("- a\n- b\n- c", "- a\n- b mine\n- c", "- a\n- b\n- c theirs").markdown).toBe(
      "- a\n- b mine\n- c theirs",
    );
    expect(merged("A\n\nB", "New\n\nA\n\nB", "A theirs\n\nB")).toMatchObject({
      markdown: "New\n\nA theirs\n\nB",
      conflicted: false,
    });
  });

  it("keeps both versions when both sides changed the same block, local first", () => {
    expect(merged("Draft", "Draft mine", "From outside")).toMatchObject({
      markdown: "Draft mine\n\nFrom outside",
      conflicted: true,
    });
    // An edit beats a delete, whichever side deleted.
    expect(merged("A\n\nB", "A\n\nB mine", "A")).toMatchObject({ markdown: "A\n\nB mine", conflicted: true });
    expect(merged("A\n\nB", "A", "A\n\nB theirs")).toMatchObject({ markdown: "A\n\nB theirs", conflicted: true });
    // Two insertions at the same place keep both.
    expect(merged("A", "A\n\nmine", "A\n\ntheirs").markdown).toBe("A\n\nmine\n\ntheirs");
  });

  it("takes the remote version when the local side changed nothing or the same thing", () => {
    expect(merged("A\n\nB", "A\n\nB", "A\n\nB\n\nC")).toMatchObject({ conflicted: false, matchesRemote: true });
    expect(merged("A", "A same", "A same")).toMatchObject({ conflicted: false, matchesRemote: true });
    expect(merged("A", "", "")).toMatchObject({ doc: md(""), matchesRemote: true });
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
