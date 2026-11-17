# Tiptap references for agents

`SKILL.md` and `references/setup.md` here are copied unchanged, in the same layout so its links work, from Tiptap's official agent skill, `ueberdosis/tiptap` at `.agents/skills/tiptap` (commit `df426b08d567`, 2026-10-02), MIT License, Copyright (c) 2025 Tiptap GmbH.
Install the live version with `npx skills add ueberdosis/tiptap`; refresh these copies from that path when it changes.
Overnote's own rules are in [`../../SKILL.md`](../../SKILL.md) and win where they differ.

Skipped because Overnote has no collaboration, AI, comments, or document conversion: `references/collaboration.md`, `references/ai.md`, and `references/document-features.md` in the same upstream folder.

## Docs as Markdown

Append `.md` to any `https://tiptap.dev/docs` page, or send `Accept: text/markdown`.

- [Docs index (`llms.txt`)](https://tiptap.dev/docs/llms.txt): every page with a one-line description.
- [Product index](https://tiptap.dev/llms.txt).
- [Styling](https://tiptap.dev/docs/editor/getting-started/style-editor.md): headless, scope CSS to the editor element.
- [Editor API](https://tiptap.dev/docs/editor/api/editor.md): `injectCSS`, `editorProps`, and the other settings.
- [Custom extensions](https://tiptap.dev/docs/editor/extensions/custom-extensions.md) and [extending existing ones](https://tiptap.dev/docs/editor/extensions/custom-extensions/extend-existing.md).
- [Decorations guide](https://tiptap.dev/docs/editor/core-concepts/decorations.md) and [Decorations API](https://tiptap.dev/docs/editor/api/decorations.md): `addDecorations` and its update strategies.
- [Suggestion utility](https://tiptap.dev/docs/editor/api/utilities/suggestion.md): triggers such as `/` and `:`.
- [Input rules](https://tiptap.dev/docs/editor/api/input-rules.md) and [paste rules](https://tiptap.dev/docs/editor/api/paste-rules.md).
- [ProseMirror access (`@tiptap/pm`)](https://tiptap.dev/docs/editor/core-concepts/prosemirror.md).
- [React install](https://tiptap.dev/docs/editor/getting-started/install/react.md).
- [What's new in Tiptap 3](https://tiptap.dev/docs/resources/whats-new.md).

## Source

- Installed: `node_modules/@tiptap/*` (version in `package.json`); lists: `node_modules/prosemirror-flat-list`.
- Upstream: https://github.com/ueberdosis/tiptap; clone only into a gitignored `.reference/`.
