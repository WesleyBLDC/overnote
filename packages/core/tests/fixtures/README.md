# Serialization fixtures

Test data for the Markdown, plain text, HTML, and clipboard serializers in `packages/core`.
`packages/core/tests/fixtures.test.ts` runs every case.
The inputs are our own text, not copied from Raycast.

## File layout

Each case `NN-name` has:

| File | Meaning |
|---|---|
| `NN-name.md` | Input markdown, fed to `markdownToDoc` |
| `NN-name.expected.md` | Expected `docToMarkdown(markdownToDoc(input))` |
| `NN-name.expected.txt` | Expected `docToPlainText` of the same document (some cases) |
| `NN-name.expected.html` | Expected `docToHTML` of the same document (some cases) |
| `NN-name.expected.clipboard.txt` | Expected plain text flavor when the whole document is selected and copied (some cases) |
| `NN-name.expected.clipboard.html` | Expected HTML flavor for the same copy (some cases) |

Rules for the test harness:

- Compare bytes exactly.
  No file has a trailing newline unless the case says so, because the serializers never emit one.
  Configure editors and git so they do not add one (`.gitattributes` marks `packages/core/tests/fixtures/** -text`, and `40-crlf-line-endings.md` must keep its CR LF bytes).
- Every `.expected.md` must also be a fixed point: `docToMarkdown(markdownToDoc(expected))` must equal `expected`.
  This idempotence check applies to every case.
- Cases 18 and 30 contain hard breaks; their `.txt`, `.html`, and clipboard files describe the document that `markdownToDoc` returns, where every line break inside a paragraph is a hard break node.
- The `.html` files are Overnote's HTML export format (see `docs/architecture.md`), not Raycast's editor markup.

## Cases

| # | Name | Tests | Extra outputs |
|---|---|---|---|
| 01 | empty-doc | Empty input gives empty markdown; the document still holds one empty paragraph | txt, html |
| 02 | whitespace-only | Spaces, tabs, and blank lines only collapse to an empty note | |
| 03 | paragraphs | Two paragraphs joined by one blank line | |
| 04 | empty-paragraphs | Runs of blank lines become empty paragraphs and back; trailing empty paragraph dropped | txt, html, clipboard |
| 05 | leading-gap | Blank lines before the first block become an empty paragraph | |
| 06 | headings | ATX headings 1 to 3, separated by blank lines | txt, html, clipboard |
| 07 | heading-variants | Level 4 clamps to 3; setext headings become ATX; `#NoSpace` stays text | |
| 08 | bold-italic | `__` and `_` become `**` and `*`; triple delimiters | |
| 09 | strike-underline | Single and double tilde become `~~`; `++` and `<u>` become `++` | |
| 10 | inline-code | Code spans are not escaped or entity encoded | |
| 11 | inline-code-backticks | Code spans that contain backticks get a longer delimiter and padding | |
| 12 | nested-marks | Mark nesting order, bold outside link | txt, html, clipboard |
| 13 | mark-reopen-html | A mark that must reopen after an outer mark closes is written as an HTML tag | |
| 14 | literal-asterisks | Stray asterisks are escaped | |
| 15 | escaping-inline | Backslash escapes for `_ [ ] \` and entity encoding for `< & >` | txt, html |
| 16 | escaping-line-start | Text that would start a block is escaped at the start of a line | |
| 17 | entities | Only four entities are decoded on input; others stay literal and their `&` is encoded | |
| 18 | hard-breaks | Two-space, backslash, and soft line breaks become hard breaks, written as two spaces plus newline | txt, html, clipboard |
| 19 | bullet-chars | `*` and `+` bullets are written as `-` | |
| 20 | ordered-numbering | Start number kept; repeated `1.` renumbered; counter resets after a non-list block | txt, html, clipboard |
| 21 | nested-bullets | Two-space indentation per bullet nesting level | |
| 22 | nested-under-ordered | Children of ordered items are indented by the marker width | txt, html, clipboard |
| 23 | tasks | `[ ]`, `[x]`, `[X]` task markers; checked written as lowercase `x` | |
| 24 | nested-tasks | Tasks nested under tasks, marks inside task text | txt, html, clipboard |
| 25 | mixed-list-kinds | Adjacent bullet, task, and ordered items stay tight with no blank lines | |
| 26 | empty-items | Empty task marker is lossy; empty bullet with a child list keeps the child | |
| 27 | code-block-language | Fenced code with language; content not escaped | txt, html, clipboard |
| 28 | code-block-variants | Tilde fence, indented code, and empty code block all become backtick fences | |
| 29 | code-fence-collision | Content containing a fence gets a longer fence | |
| 30 | blockquote | Quote with soft break, two paragraphs, and a nested quote | txt, html, clipboard |
| 31 | quote-with-blocks | Heading, list, and code inside a quote, with tight list lines | |
| 32 | horizontal-rules | All rule spellings become `---` | txt, html, clipboard |
| 33 | links | Plain, titled, schemeless, mailto, relative (dropped), javascript (dropped), autolink, bare URL, `www.` | txt, html, clipboard |
| 34 | link-parens | Parentheses in a link destination are escaped | |
| 35 | unicode-emoji | Accents, CJK, emoji with skin tone and ZWJ, shortcode text stays text | txt, html |
| 36 | table-kept-as-text | A GFM table becomes one paragraph of row lines instead of vanishing | |
| 37 | images-to-alt-text | Image syntax keeps only its alt text, inside a paragraph | |
| 38 | inline-html | Known inline HTML maps to marks, unknown wrappers drop, custom tags stay literal | |
| 39 | list-item-extra-blocks | Second paragraph and code block inside a list item keep their place | |
| 40 | crlf-line-endings | CR LF input is normalized; a single line break inside a paragraph is a hard break | |
| 41 | underline-plus-signs | `C++` text is not underline; literal `++word` is escaped | |
| 42 | all-in-one | A realistic note touching most block and mark types | txt, html, clipboard |
| 43 | ordered-paren-delimiter | `1)` items are written as `1.` | |
