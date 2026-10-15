/**
 * Runs spec/fixtures (see its README). Files are compared byte for byte.
 * Every case also checks that its expected Markdown is a fixed point of parse then serialize,
 * and that the derived title is the first line of the plain text.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildNoteContent,
  deriveTitle,
  docToClipboard,
  docToHTML,
  docToMarkdown,
  docToPlainText,
  markdownToDoc,
} from "../src/index";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../spec/fixtures");

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

const names = existsSync(FIXTURE_DIR)
  ? readdirSync(FIXTURE_DIR)
      .filter((file) => /^\d+-.+\.md$/.test(file) && !file.includes(".expected."))
      .map((file) => file.slice(0, -".md".length))
      .sort()
  : [];

describe.skipIf(names.length === 0)("spec fixtures", () => {
  for (const name of names) {
    const base = join(FIXTURE_DIR, name);
    describe(name, () => {
      const source = read(`${base}.md`) ?? "";
      const doc = markdownToDoc(source);
      const expectedMarkdown = read(`${base}.expected.md`);
      const checks: [string, string | undefined, () => string][] = [
        ["markdown", expectedMarkdown, () => docToMarkdown(doc)],
        ["text", read(`${base}.expected.txt`), () => docToPlainText(doc)],
        ["html", read(`${base}.expected.html`), () => docToHTML(doc)],
        ["clipboard text", read(`${base}.expected.clipboard.txt`), () => docToClipboard(doc).text],
        ["clipboard html", read(`${base}.expected.clipboard.html`), () => docToClipboard(doc).html],
      ];
      for (const [kind, expected, actual] of checks) {
        if (expected === undefined) continue;
        it(kind, () => {
          expect(actual()).toBe(expected);
        });
      }
      if (expectedMarkdown !== undefined) {
        it("expected markdown is a fixed point", () => {
          expect(docToMarkdown(markdownToDoc(expectedMarkdown))).toBe(expectedMarkdown);
        });
      }
      it("title is the first line of the plain text", () => {
        const text = docToPlainText(doc);
        expect(deriveTitle(doc)).toBe((text.split("\n")[0] ?? "").trim());
        const content = buildNoteContent(doc);
        expect(content).toMatchObject({ markdown: docToMarkdown(doc), text, title: deriveTitle(doc) });
      });
    });
  }
});

it("finds the fixtures folder", () => {
  expect(names.length).toBeGreaterThan(0);
});
