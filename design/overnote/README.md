# Overnote design handoff (for Claude Code)

This folder is the finalized design for **Overnote**, a floating Markdown notepad for macOS (Raycast extension, local SQLite, MIT). Use it to restyle and extend the existing app. Everything here was signed off; implement it as specified rather than reinterpreting it.

## How to use this folder

1. Copy this folder into the repo, e.g. `design/overnote/`, and keep it there as reference.
2. Read **SPEC.md** end to end before changing code. It has every size, colour, state and shortcut.
3. Look at the matching image in `screens/` for each part you build. Open the matching file in `reference-html/` when you need an exact CSS value: those are static HTML renders of the same boards with every style inline.
4. Work in the order of the task list below, one task per commit. After each task, compare your screen with the PNG, in both light and dark mode.

## What's in here

| Path | What it is |
|---|---|
| `SPEC.md` | The full design spec. Source of truth for behaviour, sizes and shortcuts. |
| `tokens/theme.css` | Drop-in replacement for `editor/src/styles/theme.css`: colour tokens for light + dark, type and layout variables, `@font-face` for Geist. |
| `tokens/tokens.json` | The same colour tokens as JSON (dark, light, usage). |
| `screens/01-…12-*.png` | One image per finalized board, @2x. |
| `reference-html/*.html` | Static HTML of each board with inline styles. Reference only, not production code. |
| `icons/*.svg` | UI icons. 24 grid, 1.6 stroke, round caps, `currentColor`. |
| `fonts/` | Geist and Geist Mono variable `.woff2` + OFL licence. Bundle them; macOS doesn't ship Geist. |
| `logo/` | App icon, mark, wordmark and lockups as SVG and PNG; `.icns`; Raycast `extension-icon.png`; menu bar template images; favicon. |

## Rules that apply everywhere

- **Tokens only.** Components use `var(--token)`, never hex values. Light and dark switch through `prefers-color-scheme` (plus the Appearance setting: Light / Dark / Auto).
- **No purple.** The old iris accent (`#8f80ff` / `#5b4bd5`) is gone. The accent is near-black in light mode and near-white in dark mode.
- **Fonts:** Geist for UI and notes, Geist Mono for code, the terminal and keyboard shortcuts. SF Pro / SF Mono are fallbacks.
- **One top bar, one bottom row.** Top bar: terminal, notes, actions, new note. Bottom row: format island centred, count + Aa in the corner. Nothing else lives in those bars.
- **The island is always centred** on the panel and never overlaps the corner (see SPEC §5).
- Respect `prefers-reduced-motion`: drop fades and slides to instant changes.

## Task list

1. **Theme and fonts.** Replace `theme.css` with `tokens/theme.css`, bundle `fonts/`, remove every purple value and hard-coded colour. *Done when* light and dark match `screens/02-theme.png` and nothing purple is left.
2. **Top bar.** 46 pt bar, four 30 pt buttons with the new icons, tooltips with shortcuts, no repeated title (it fades into the bar centre once the title scrolls away). *Ref:* `04-editor.png`.
3. **Note content styles.** Title, heading, subheading, body, lists, checklist, quote, inline code, code block, divider, table, link card. *Ref:* `10-content.png`, `04-editor.png`.
4. **Corner count + Aa.** One count button that toggles words ↔ characters (icon shows which), selection shows only the selected count, 5-character cap with k/M. *Ref:* `05-toolbar.png`.
5. **Format island.** Compact 176 × 28 pt island, centred in the bottom row, shows on hover or selection, pinned with Aa or ⌥⌘,. *Ref:* `05-toolbar.png`.
6. **Search (replaces the ⌘K and ⌘P menus).** Floating Spotlight-style box: field, key-action chips, notes list, live preview, sort menu, “>” or ⌘K for all actions. *Ref:* `07-search.png`.
7. **Slash menu.** `/` block menu with Markdown shortcuts. *Ref:* `10-content.png`.
8. **Empty new note.** Ghost “Untitled” title, hint line, keycap hints that fade on first keystroke. *Ref:* `09-empty.png`.
9. **Settings.** One grouped list, Graphite toggles and segmented controls, “Delete all notes” moved here. *Ref:* `08-settings.png`.
10. **Find, delete, toasts.** ⌘F find bar, ⌘⌫ delete with Undo toast, Delete-all confirm, Recently Deleted view, toast styles. *Ref:* `11-feedback.png`.
11. **Terminal drawer.** Restyle the drawer and the full-panel view with the back button. *Ref:* `06-terminal.png`.
12. **Light mode pass.** Check every surface against `12-light.png`.
13. **Brand assets.** Replace the app/extension icons with files from `logo/` (see `logo/README.txt`).

## Checking your work

- Compare each screen to its PNG side by side, at 100% and in both modes.
- Text contrast: body ≥ 4.5:1; `--text-tertiary` is the lightest colour allowed for text under 14 pt.
- Resize the panel down to 440 pt: the island stays centred and never touches the corner.
- Type a 120,000-word note: the corner shows `120k` and doesn't grow.
- Every shortcut in SPEC §12 works and is shown in its tooltip or menu row.
