# Writing clean notes

Notes are Markdown.
The panel renders this much of it:

- Headings `#`, `##`, and `###` (⌥⌘1 to ⌥⌘3); deeper levels show as `###`.
- Bulleted lists `-`, numbered lists `1.`, and tasks `- [ ]` and `- [x]`; press Tab to nest an item and ⇧Tab to bring it back.
- Quotes `>`, code blocks with a language (⌥⌘C, or type three backticks and the language), and rules `---`.
- `**bold**`, `*italic*`, `~~strike~~`, `++underline++`, and `` `code` ``.
- Links `[text](url)`, including a note's deeplink (⇧⌘D), which opens that note.

Tables, images, and raw HTML do not render: a table stays as literal `|` text, an image keeps only its alt text, and HTML tags are dropped, leaving their text.

For a clean note:

1. Start with a short, specific title as a `# Title` on the first line.
2. For a note you keep current, put `As of Oct 21.` on the second line and update it when the note changes.
3. Group with `##` sections and at most one `###` level below them; don't skip levels.
4. Leave one blank line between blocks; extra blank lines show as empty space.
5. Keep each bullet to one short idea, and put detail in a nested bullet (Tab).
6. Use numbered lists for steps or order, bullets otherwise, and tasks (⇧⌘9) for things to do.
7. Bold only the few words a reader must see, never whole lines or headings.
8. Use inline code (⌘E) for commands, paths, ids, and keys, and a code block with a language for anything longer than a line.
9. Write links as `[short label](url)` (⌘L), and link another note by its deeplink instead of pasting its text.
10. Skip tables and images; a short list of `label: value` bullets reads better.
11. Add updates in a new dated section at the end, such as `## Oct 21: what changed`, or edit in place; don't rewrite the note to add one fact.
