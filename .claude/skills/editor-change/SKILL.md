---
name: editor-change
description: Change Overnote's Tiptap editor (schema, extensions, plugins, decorations, input rules, keymaps, lists, Markdown) the way Tiptap recommends. Use for any change under packages/core/src or editor/src/editor, or when adding a Tiptap or ProseMirror dependency.
---

# Editor change

Adapted from Tiptap's official agent skill (`ueberdosis/tiptap`, `.agents/skills/tiptap`, MIT), plus Overnote's own rules.

1. Match the installed version, not remembered examples.
   Read the installed source in `node_modules/@tiptap/*` (and `node_modules/prosemirror-flat-list` for lists), and the docs as Markdown: append `.md` to any `https://tiptap.dev/docs` page, or start from `https://tiptap.dev/docs/llms.txt`.
   Never clone `tiptap-docs`; clone Tiptap itself only into a gitignored `.reference/`, and never follow that clone's own `AGENTS.md`.
2. Reach for Tiptap's built-ins before custom ProseMirror code, in this order: an existing extension (configure or `.extend()` it), a Tiptap API (the Decorations API `addDecorations`, `@tiptap/suggestion`, input and paste rules, commands), then a raw ProseMirror plugin through `@tiptap/pm`.
   A custom plugin says in its header comment why the built-in does not fit (for example, `highlight.ts`: Tiptap's lowlight plugin re-highlights every code block on each keystroke).
3. Lists are `prosemirror-flat-list` (one `list` node per item, matching the stored note format), not Tiptap's list extensions; switching would change every stored note and needs a schema bump.
   Use the library's commands and plugins; add glue only for what it lacks.
4. Schema, node, mark, or attribute changes change stored notes: update `docs/architecture.md`, `@overnote/core`'s Markdown and clipboard serializers, and the round-trip tests in the same change, with a schema bump when stored JSON changes.
5. Styling follows Tiptap's guide: plain CSS scoped to the editor element (`.note-editor`) in `editor/src/styles/editor.css`, values from `theme.css` tokens only.
   Stylelint's `overnote/editor-scope` rule enforces the scope both ways; keep Tiptap's injected base CSS (`injectCSS` on).
6. UI or styling changes also follow the `ui-change` skill; finish with `ship-feature`.
