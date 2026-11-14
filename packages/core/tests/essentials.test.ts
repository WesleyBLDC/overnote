/** The few rules the fixtures and the end-to-end flows cannot reach cheaply. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
  buildNoteContent,
  countCharacters,
  countWords,
  docToMarkdown,
  docToPlainText,
  duplicateContent,
  fold,
  getNoteSchema,
  highlightMarkdownMatches,
  loadDoc,
  markdownToDoc,
  mergeDocs,
  noteContentFromMarkdown,
  orderedMarkerLabels,
} from "../src/index";

describe("text rules", () => {
  it("folds every entry of the golden corpus the Swift helper also reads", () => {
    const corpus = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fold-corpus.json"), "utf8"),
    ) as { input: string; folded: string }[];
    expect(corpus.length).toBeGreaterThanOrEqual(20);
    for (const entry of corpus) expect(fold(entry.input), JSON.stringify(entry.input)).toBe(entry.folded);
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

  it("puts a duplicate's title suffix on the line the title comes from", () => {
    const copy = (markdown: string) => {
      const content = duplicateContent(noteContentFromMarkdown(markdown), " copy");
      // Every field comes from the suffixed document, so a later save derives the same title.
      expect(content).toEqual(buildNoteContent(loadDoc(content.rawContent, "")));
      return content;
    };
    expect(copy("# Groceries\n\n- milk")).toMatchObject({
      title: "Groceries copy",
      markdown: "# Groceries copy\n\n- milk",
      text: "Groceries copy\n\nmilk",
    });
    expect(copy("**Plan**  \nsecond line").markdown).toBe("**Plan** copy  \nsecond line");
    expect(copy("```\nfirst\nsecond\n```").text).toBe("first copy\nsecond");
    // A blank title line starts with the suffix, without its leading space.
    expect(copy("```\n\nsecond\n```").markdown).toBe("```\ncopy\nsecond\n```");
    expect(copy("")).toMatchObject({ title: "copy", text: "copy" });
  });
});

describe("merging an outside change into unsaved edits", () => {
  const md = (text: string) => markdownToDoc(text);
  const merged = (base: string, local: string, remote: string) => {
    const result = mergeDocs(md(base), md(local), md(remote));
    return { ...result, markdown: docToMarkdown(result.doc) };
  };

  // The simple cases (blocks apart, the same block, an outside delete, no local change) run end to
  // end in editor/tests/autosave.spec.ts; these are the alignment rules behind them.
  it("keeps every change from both sides, local first where they collide", () => {
    // [base, local, remote, merged markdown, conflicted]
    const cases: [string, string, string, string, boolean][] = [
      // Adjacent list items, and an insertion before a changed block, are independent.
      ["- a\n- b\n- c", "- a\n- b mine\n- c", "- a\n- b\n- c theirs", "- a\n- b mine\n- c theirs", false],
      ["A\n\nB", "New\n\nA\n\nB", "A theirs\n\nB", "New\n\nA theirs\n\nB", false],
      // Two insertions at the same place keep both.
      ["A", "A\n\nmine", "A\n\ntheirs", "A\n\nmine\n\ntheirs", true],
      // A local join of two blocks against a remote edit of one of them keeps both versions.
      ["A\n\nB", "AB", "A\n\nB theirs", "AB\n\nA\n\nB theirs", true],
      // An edit wins over a local delete, without a conflict.
      ["A\n\nB", "A", "A\n\nB theirs", "A\n\nB theirs", false],
      // An insertion inside a range the other side deleted brings the deleted blocks back around it.
      ["A\n\nB\n\nC\n\nD", "A\n\nD", "A\n\nB\n\nX\n\nC\n\nD", "A\n\nB\n\nX\n\nC\n\nD", false],
      ["A\n\nB\n\nC\n\nD", "A\n\nB\n\nX\n\nC\n\nD", "A\n\nD", "A\n\nB\n\nX\n\nC\n\nD", false],
      // Duplicate identical blocks line up so each side's change lands once.
      ["X\n\nX\n\nX", "X\n\nX mine\n\nX", "X\n\nX\n\nX\n\nY", "X\n\nX mine\n\nX\n\nY", false],
      ["X\n\nY\n\nX", "X mine\n\nY\n\nX", "X\n\nY\n\nX theirs", "X mine\n\nY\n\nX theirs", false],
      // The same change on both sides is no conflict.
      ["A", "A same", "A same", "A same", false],
    ];
    for (const [base, local, remote, markdown, conflicted] of cases) {
      expect(merged(base, local, remote), JSON.stringify([base, local, remote])).toMatchObject({
        markdown,
        conflicted,
      });
    }
    // matchesRemote tells the editor it can take the remote version as is.
    expect(merged("A\n\nB\n\nC\n\nD", "A\n\nD", "A\n\nB\n\nX\n\nC\n\nD").matchesRemote).toBe(true);
    expect(merged("A", "A same", "A same").matchesRemote).toBe(true);
    expect(merged("A\n\nB\n\nC\n\nD", "A\n\nB\n\nX\n\nC\n\nD", "A\n\nD").matchesRemote).toBe(false);
  });

  it("treats a changed middle too large to compare as one replaced range, still losing nothing", () => {
    // 2,100 by 2,100 blocks is past MAX_LCS_CELLS once local changes both ends.
    const base = Array.from({ length: 2100 }, (_, i) => `p${i}`);
    const local = ["first mine", ...base.slice(1, -1), "last mine"];
    const appended = mergeDocs(md(base.join("\n\n")), md(local.join("\n\n")), md([...base, "theirs"].join("\n\n")));
    expect(appended.conflicted).toBe(false);
    expect(docToMarkdown(appended.doc)).toBe([...local, "theirs"].join("\n\n"));
    // A remote edit inside that range keeps the whole local version, then the whole remote one.
    const remote = base.map((block, i) => (i === 1000 ? "middle theirs" : block));
    const edited = mergeDocs(md(base.join("\n\n")), md(local.join("\n\n")), md(remote.join("\n\n")));
    expect(edited.conflicted).toBe(true);
    expect(docToMarkdown(edited.doc)).toBe([...local, ...remote].join("\n\n"));
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

describe("ordered list markers", () => {
  it("follows ordered parents only, restarts runs, and skips a list that opens with a list", () => {
    const item = (kind: string, text: string | null, ...children: object[]) => ({
      type: "list",
      attrs: { kind, order: null, checked: false, collapsed: false },
      content: [...(text === null ? [] : [{ type: "paragraph", content: [{ type: "text", text }] }]), ...children],
    });
    const doc = getNoteSchema().nodeFromJSON({
      type: "doc",
      content: [
        item("ordered", "a", item("ordered", "a1", item("ordered", "a11")), item("bullet", "b", item("ordered", "b1"))),
        item("ordered", "c"),
        { type: "paragraph" },
        item("ordered", null, item("ordered", "d1")),
        item("ordered", "e"),
      ],
    });
    expect([...orderedMarkerLabels(doc).values()]).toEqual(["1.", "1.1", "1.1.1", "1.", "2.", "1.", "1."]);
  });
});
