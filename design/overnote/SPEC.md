# Overnote design spec

Units are CSS px (= macOS pt at 1×). Colour names are tokens from `tokens/theme.css`. Each section names the board image it matches.

---

## 1. Brand — `screens/01-logo.png`, `logo/`

- Mark: a white ring (O) over the top-left of a large grey N; a gap is cut into the N around the ring. Solid colours only, no gradients or transparency.
- Colours: tile `#111113`, O `#FFFFFF`, N `#8A8A90`. Tile corner radius 22.5% of its size.
- Wordmark: “overnote”, Geist Bold, lowercase, −4.5% tracking.
- Menu bar: one-colour template image (`logo/png/menubar/overnoteTemplate.png` + `@2x`); macOS tints it.
- Raycast: `logo/png/raycast/extension-icon.png` (512 px).

## 2. Colour — `screens/02-theme.png`, `tokens/`

Use the tokens in `tokens/theme.css`. Key ones:

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg-panel` | #18181A | #FBFBFC | Note panel |
| `--bg-raised` | #232326 | #FFFFFF | Menus, popovers, toasts, pinned island |
| `--bg-sunken` | #111113 | #F1F1F3 | Terminal drawer, inputs |
| `--bg-code` | #26262A | #EDEDF0 | Inline code, code blocks |
| `--text` / `--text-secondary` / `--text-tertiary` | #EDEDEF / #A1A1A8 / #8E8E95 | #1A1A1D / #5F6168 / #6B6E75 | Text levels |
| `--accent` / `--accent-strong` | #E4E4E7 / #FFFFFF | #27272A / #18181B | Checked boxes, list numbers, active icons, links |
| `--accent-soft` | white 12% | ink 8% | Active and hover fills |
| `--row-selected` | white 8% | ink 6% | Highlighted row in every list and menu |
| `--danger` / `--success` / `--warning` | #FF7B72 / #7DD69A / #E6B673 | #C9302C / #1F7A45 / #9A5B00 | States; `--warning` also marks find matches |
| `--island` | rgba(35,35,38,.88) | rgba(255,255,255,.88) | Format island, 20 px blur |

## 3. Type — `screens/03-font.png`

| Role | Size / weight / line height | Notes |
|---|---|---|
| Note title (`#`) | 23 / 600 / 1.3, −1% | First line of a note |
| Heading (`##`) | 18 / 600 / 1.35 | |
| Subheading (`###`) | 15 / 600 / 1.4 | |
| Body | 15 / 400 / 1.6 | |
| Secondary | 13 / 500 | Menu rows, list titles |
| Small | 11.5 / 500 | Counts, meta lines, footers |
| Label | 11 / 600, +6%, uppercase | Group labels (10.5 in Settings) |
| Code | Geist Mono 13 / 400 / 1.65 | Inline and blocks |
| Terminal | Geist Mono 12 / 400 / 1.75 | |

Tracking tightens with size: 0 at body, −1% at 20+, −2% at 28+. Use tabular numerals for all counts.

## 4. Panel and top bar — `screens/04-editor.png`

- Panel radius 14, edge `0 0 0 0.5px var(--border-strong)`. Note padding 28 left/right, 48 bottom (room for the bottom row).
- Top bar 46 tall, padding `0 12 0 16`. Window control at left; the middle is empty and draggable. When the note title scrolls out of view, it fades into the bar centre (12.5 / 500, `--text-tertiary`).
- Four buttons on the right, 30 × 30, radius 8, gap 2, icons 17 px in `--text-secondary`: **Terminal** (`icons/term.svg`, ⌃\`), **Notes / Search** (`notes.svg`, ⌘P), **Actions** (`cmd.svg`, ⌘K), **New note** (`new.svg`, ⌘N).
- Hover: `--accent-soft` fill and a tooltip such as “Actions ⌘K” (`--bg-raised`, 11.5, radius 6). Active (e.g. terminal open): `--accent-soft` fill and `--accent-strong` icon.

## 5. Bottom row: format island and corner count — `screens/05-toolbar.png`

**Corner** (bottom-right, 12 from right and bottom edges, 4 gap):
- **Count button**: 24 tall, padding 0 8, radius 6, 11.5 / 500 tabular, `--text-tertiary`; the number then a 13 px icon (`words.svg` = words, `chars.svg` = characters). No label.
- Click toggles words ↔ characters; remember the choice. Hover tooltip shows the full value (“1,244 words”).
- With a selection it shows **only the selected count** (“7”), in `--text-secondary`. Never “7/1,244”.
- Never wider than 5 characters: `0–9,999` as is; `10,000–99,999` → `12.4k`; `100,000–999,999` → `128k`; `1,000,000+` → `1.2M`.
- **Aa button**: 24 tall, padding 0 7, radius 6, 11.5 / 600, `--text-secondary`, inset 1 px `--border-strong`. Pinned: `--accent-soft` fill, `--accent-strong` text, no outline.
- Corner max width 110.

```ts
const fmt = (n: number) =>
  n < 10_000 ? n.toLocaleString()
  : n < 100_000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  : n < 1_000_000 ? Math.round(n / 1000) + 'k'
  : (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
```

**Format island**:
- 176 × 28, padding 2, radius 8, `--island` with 20 px backdrop blur, shadow `0 6px 18px rgba(0,0,0,.35)` (light `.12`) plus a 0.5 px hairline.
- Buttons 24 × 24, radius 6, 12 / 600: **H**, **B**, *I*, divider (1 × 12), `</>` (30 wide, Geist Mono 11), **”** quote, **☰** list. Active button: white 12% fill (light: ink 8%). Tooltips on hover; no labels.
- Position: `position:absolute; left:50%; transform:translateX(-50%); bottom:10px`. Centred on the **panel**, on the same line as the corner (their centres align). It never measures or moves for the corner.
- Shows on hover over the bottom of the note, or whenever text is selected; fades in/out over 150 ms. **Pinned** (Aa or ⌥⌘,) keeps it visible and uses `--island-pinned`.
- Panel minimum width 440 (12 + 110 + 8 + 176 + 8 + 110 + 12 ≈ 436). If the window is ever narrower, hide the count first; Aa and the centred island stay.

## 6. Note content — `screens/10-content.png`

- Block spacing 12, 20 above headings, list indent 20 per level.
- Bullets `•` then `◦` (nested, `--text-secondary`). Numbers in `--accent`, weight 600.
- Checklist: 16 × 16 box, radius 4. Checked = `--accent` fill, `--on-accent` check (`icons/check.svg`, 11 px); text struck and `--text-tertiary`. Unchecked = 1.5 px inset ring (#5A5A60 dark / #B4B6BB light).
- Quote: 3 px bar, radius 2, white 22% (light ink 18%), 14 gap; text #D4D4D8 dark / #3A3D43 light. No italics.
- Inline code: Geist Mono 13, `--bg-code`, padding 1 5, radius 5. Code block: `--bg-code`, radius 10, padding 12 14; language + “Copy” top-right (10.5, `--text-tertiary`); keywords `--warning`, strings `--success`, comments `--text-tertiary`.
- Links: `--accent-strong` with an underline in `--link-underline`, offset 3. A pasted URL on its own line becomes a link card (`--bg-raised`, radius 10, 26 px icon tile, title + domain).
- Highlight: `--warning` at ~26% behind the text. Divider: 1 px `--border`.
- Table: radius 10, 1 px border, header row `--bg-raised` (light `--bg-sunken`) weight 600, cells padding 7 10.

## 7. Search (replaces ⌘K and ⌘P menus) — `screens/07-search.png`

- Floating over the screen, horizontally centred, ~15% from the top. 700 wide, up to 520 tall. Radius 18, `--search-glass` with 30 px blur and saturate 1.4, `--shadow-search`.
- **Field** 56 tall, 21 px text, search icon 20 px. Placeholder: “Search notes or type > for actions”. Right side: sort pill “Modified ▾” (12 px, `--accent-soft`).
- **Key actions row** (visible only while the field is empty): chips 30 tall, radius 9, padding 0 10, white 7% (light ink 5%), 12.5 px text, 14 px icon, shortcut in Geist Mono 10.5 `--text-tertiary`: New ⌘N · Pin ⇧⌘P · Copy link ⇧⌘D · Terminal ⌃\` · Settings ⌘,. Right-aligned outlined chip “All actions ⌘K”.
- **Body**: list column 270, preview fills the rest; divided by 1 px `--border`.
  - Empty query: groups “Pinned” then “Recent”. Row = note icon 15 + title (13 / 500 when highlighted) + meta line (11.5 `--text-tertiary`). Highlighted row `--row-selected`, radius 10. The current note shows “Current”.
  - Typing: notes first (matches highlighted with `--find-match`, snippet jumps to the match), then a group “Actions” with matching actions, and always a final “New note ‘query’ ⌘↩”.
  - Preview: title 18 / 600, body 13 / 1.65 `--text-secondary`, footer meta (Created · Edited · words).
- **Footer** 34 tall: “↩ Open · ⌘↩ New window · ⌘⌫ Delete”, count on the right.
- **All actions mode** (⌘K, or typing `>`): an “Actions” token replaces the placeholder. Left: Duplicate ⌘D, Find in Note ⌘F, Share ›, Window ›, Zoom ›, Recently Deleted ›, divider, Delete Note ⌘⌫ (`--danger`). Right pane shows the highlighted submenu (e.g. Window: Fill Left ⌃⌥←, Fill Right ⌃⌥→, Fill Screen ⌃⌥↑, Centre ⌃⌥↓, Float on top ⇧⌘T). Backspace on the token returns to notes.
- **Sort menu**: Last opened, Modified, Created, Title, Length; Newest first; Pinned on top. The meta line follows the sort (“Created Nov 2”, “Opened 2h ago”).
- Keys: ↑↓ move, ↩ open, → open submenu, ⌘⌫ delete highlighted note, esc closes.

## 8. Slash menu — `screens/10-content.png`

- Opens on `/` at the start of a line or after a space, anchored under the caret. 210–300 wide, `--bg-raised`, radius 12, `--shadow-menu`, padding 4.
- Rows 30 tall, radius 7, 20 px icon tile (white 8% / ink 6%), label, Markdown shortcut right-aligned (Geist Mono 10.5, `--text-tertiary`).
- Groups: **Text** (Text, Title `#`, Heading `##`, Subheading `###`), **Lists** (Bulleted `-`, Numbered `1.`, Checklist `[ ]`), **Blocks** (Quote `>`, Code block ```` ``` ````, Divider `---`, Table `|`, Link card ⌘L).
- Typing filters to a “Best match” group; ↩ inserts, esc closes and keeps the typed text.

## 9. Empty new note — `screens/09-empty.png`

- Ghost title “Untitled” (23 / 600, #5A5A60 dark / #B4B5BA light) with the caret on that line; below it “Start with a title, or just write.” (15, one step lighter).
- Bottom-left keycap hints, 28 from the left, 16 from the bottom: `/` Blocks · `⌘K` Actions · `⌘P` Notes. Keycaps Geist Mono with a 1 px inset outline, label 11.5 `--text-tertiary`.
- Corner shows `0` + words icon and Aa as usual.
- First keystroke on the title line makes it the note title; ↩ moves to the body. Hints fade out over 150 ms and don't return for that note.

## 10. Settings — `screens/08-settings.png`

- Opens inside the panel. Header 46 tall: window control, “‹”, “Settings” (13 / 600), search field (180 × 26, `--bg-sunken`, radius 7) on the right. Search filters rows live and hides empty groups; ⌘F focuses it.
- Rows 38 tall, hairline dividers, 28 side padding, text 13. Group labels 10.5 / 600 caps `--text-tertiary`.
- **Window**: Float above other apps (toggle) · Auto-size to note (toggle) · Show in all Spaces (toggle).
- **Display**: Appearance (Light | Dark | Auto) · Font (Geist ▾, alt SF) · Zoom (− 100% +) · Corner count (Words | Characters | Off).
- **Editor**: Pin format island ⌥⌘, (toggle) · Spellcheck · Smart quotes and dashes.
- **Data**: Notes folder (path + “Change…”) · Backups (last time + “Back up now”) · Delete all notes (“Delete…” outlined in `--danger`, opens the confirm in §11).
- Toggle 30 × 18, knob 14. On: `--accent` track, `--bg-panel` knob. Off: #3A3A3E / #D4D4D8 track, muted knob. Segmented: `--bg-sunken` track, selected segment #2E2E32 dark / white with a 1 px shadow light.

## 11. Find, delete, feedback — `screens/11-feedback.png`

- **Find (⌘F)**: bar slides down under the top bar, 12 side inset, 34 tall, radius 9, `--bg-raised`. Contents: search icon, query, “2 of 3”, ↑ ↓, divider, Replace, ×. All matches `--find-match`; current match solid `--find-current` with `--bg-panel` text. ↩ / ⇧↩ step; esc closes and leaves the caret on the match.
- **Delete note (⌘⌫)**: deletes at once, opens the next note, shows toast “Note deleted [Undo ⌘Z]” for 6 s. No dialog.
- **Delete all notes** (Settings only): dimmed backdrop (black 45%), dialog `--bg-raised` radius 14 padding 18: “Delete all 24 notes?”, explainer (moves to Recently Deleted for 30 days), text field that must read `DELETE`, Cancel + “Delete all” (`--danger` fill, disabled until DELETE is typed).
- **Recently Deleted**: the Search box with a “Recently Deleted” token; rows show “Deleted 2d ago · 28 days left”; preview dimmed; footer “↩ Restore · ⌘⌫ Delete forever · Kept 30 days”.
- **Toasts**: top centre, 8 below the top bar, one at a time. 34 tall, radius 10, `--bg-raised`, `--shadow-menu`, 12.5 text, 16 px round status icon (`--success`, `--warning`, `--danger`, or neutral). Optional action button (24 tall, white 10% / ink 7%). Duration 2.5 s, or 6 s with an action. Examples: “Link copied”, “Backed up to ~/Overnote”, “Note pinned [Unpin]”, “Couldn't save, retrying…”, “Export failed [Retry]”.

## 12. Terminal drawer — `screens/06-terminal.png`

- Drawer under the note, `--bg-sunken`, 1 px `--border` on top, default 300 tall. Opening it highlights the terminal button in the top bar.
- Drawer header 32 tall, Geist Mono 11 `--text-tertiary`: status dot, project name (`--text`), shell name; right: expand (22 px, outlined, ⌘⇧↩) and close (⌃\`).
- Prompt: short path in `--text-tertiary`, bold `❯` in `--accent-strong`; no user@host. ANSI blue and magenta map to `--accent-strong`, bright black to `--text-tertiary`.
- **Full-panel view** (expand): the terminal fills the panel; top bar shows “‹ Note title” (back pill, white 8%) at left, session name centred, collapse at right. Back or ⌘⇧↩ returns to the note with the drawer still open; the session keeps running. Agent prompts (e.g. Claude Code) sit in a rounded #1C1C1F block.

## 13. Light mode — `screens/12-light.png`

Same layout and sizes; only tokens change. Glass turns white (82%), menus are solid `--bg-raised` white with soft shadows, the accent is near-black, find uses #9A5B00. The table at the bottom right of the board lists each dark → light swap.

## 14. Keyboard shortcuts

| Action | Keys |
|---|---|
| Search notes | ⌘P |
| All actions | ⌘K (or `>` in search) |
| New note | ⌘N |
| Pin note | ⇧⌘P |
| Copy deeplink | ⇧⌘D |
| Duplicate note | ⌘D |
| Delete note | ⌘⌫ (Undo ⌘Z) |
| Find in note | ⌘F |
| Toggle terminal drawer | ⌃\` |
| Expand / collapse terminal | ⌘⇧↩ |
| Pin format island | ⌥⌘, |
| Settings | ⌘, |
| Window: fill left / right / screen / centre | ⌃⌥← / ⌃⌥→ / ⌃⌥↑ / ⌃⌥↓ |
| Float on top | ⇧⌘T |
| Open result in new window | ⌘↩ (in search) |

## 15. Motion

- Fades 150 ms ease-out (island, hints, tooltips). Find bar and toasts slide 6 px + fade, 180 ms.
- Search opens with a 120 ms scale from 0.98 + fade.
- With `prefers-reduced-motion`, all of these become instant.
