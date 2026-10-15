# Component contract (v2)

v2 (2026-10-14) applies spec/data.md section 11; see the changelog at the end.

This is the single source of truth for how the four components talk to each other.
Change it only through the orchestrator; if you need a change, write it in your final report under "Contract change requests" and implement against the current version meanwhile.

```
Raycast extension (src/)  ──socket JSON-RPC──▶  OvernoteHelper (helper/)
                                                   │  WKScriptMessageHandler bridge
@overnote/core (packages/core/)  ◀── used by ──┴─ editor (editor/) running in WKWebView
```

## 1. Files and paths

| Thing | Path |
|---|---|
| Extension root | repo root (`package.json` is the Raycast manifest) |
| Helper binary (built) | `assets/bin/OvernoteHelper` (universal, ad-hoc signed) plus `assets/bin/OvernoteHelper.sha256` |
| Editor build | `assets/editor/` (`index.html` plus relative assets; Vite `base: "./"`) |
| Data dir | `environment.supportPath` of the extension, passed to the helper as `--support-dir` |
| Database | `<support-dir>/notes.sqlite` (WAL) |
| Socket | `/tmp/overnote-<uid>/helper.sock`; the directory is created with mode 0700 by whoever starts first |
| PID file | `/tmp/overnote-<uid>/helper.pid` |
| Helper log | `<support-dir>/helper.log` (rotated at 1 MB) |

Helper command line:

```
OvernoteHelper --support-dir <dir> --socket <path> --pid-file <path> --editor-dir <assets/editor> [--show] [--version]
```

`--version` prints the version string and exits.
`--show` shows the panel right after startup.

## 2. Wire protocol (socket)

- Unix domain stream socket, UTF-8, one JSON object per line (`\n` terminated).
- Request: `{"id": <int|string>, "method": "<name>", "params": {...}}`.
- Response: `{"id": ..., "result": ...}` or `{"id": ..., "error": {"code": <int>, "message": "<text>"}}`.
- Many requests may be in flight on one connection; responses can arrive out of order and are matched by `id`.
- Error codes: `-32700` unparseable JSON (with `id: null`), `-32601` unknown method (also bridge-only methods on the socket), `-32602` bad params, `404` note not found, `409` invalid state (for example pin or move on a trashed or unpinned note), `500` internal.
- `touchAccessed` on a missing id is a silent no-op; `permanentlyDelete` on a missing id is 404; `window.show {noteId}` is 404 for a missing note and persists it as current.
- `notes.update` sets `updatedAt` to max(now, old + 1) so same-millisecond edits still change it.
- The helper also accepts `--headless` (no window) for smoke tests and CI.
- Clients must time out after 3 s (10 s for `system.shutdown`).

## 3. Bridge protocol (editor ⇄ helper)

- Web to native: `window.webkit.messageHandlers.overnote.postMessage({ id, method, params })`.
- Native to web replies: the helper calls `window.overnoteBridge.resolve(id, result)` or `window.overnoteBridge.reject(id, { code, message })`.
- Native to web events: `window.overnoteBridge.emit(event, payload)`.
- The editor must define `window.overnoteBridge` before it sends anything.
  When it is ready it calls `system.ready`.
- **The same method names and shapes as the socket**, served by one dispatcher in the helper.
  Bridge-only methods are marked (bridge) below.
- Assets are served from the custom scheme `overnote://app/` (for example `overnote://app/index.html`), mapped to `--editor-dir`.

### Events (native to web)

| Event | Payload | When |
|---|---|---|
| `window.didShow` | `{}` | The panel became visible |
| `window.didHide` | `{}` | The panel was hidden |
| `window.didBecomeKey` / `window.didResignKey` | `{}` | Focus changes |
| `note.open` | `{ id: string }` | An external caller asked to show a specific note |
| `note.new` | `{ note: Note }` | An external caller created a note and asked to show it |
| `notes.changed` | `{ ids: string[] }` | Data changed through the socket (so the editor reloads) |
| `settings.changed` | `Settings` | A setting changed |

## 4. Data types

```ts
type NoteId = string;          // ULID, 26 chars, Crockford base32, lexicographically sortable
type Millis = number;          // Unix epoch milliseconds

interface NoteContent {
  rawContent: string;          // JSON.stringify(ProseMirror doc JSON); canonical
  markdown: string;            // derived by @overnote/core
  text: string;                // plain text, derived by core
  title: string;               // derived by core: first line of the plain text (empty blocks skipped), trimmed, no length cap (may be empty)
}

interface Note extends NoteContent {
  id: NoteId;
  pinned: number | null;       // fractional sort key; null = not pinned
  createdAt: Millis;
  updatedAt: Millis;
  deletedAt: Millis | null;
  lastAccessedAt: Millis | null;
  caretPosition: number | null;
}

interface NoteSummary {        // list rows: no rawContent or markdown
  id: NoteId; title: string; preview: string /* first 200 chars of text */;
  charCount: number;           // characters of text
  pinned: number | null; createdAt: Millis; updatedAt: Millis;
  deletedAt: Millis | null; lastAccessedAt: Millis | null;
}
// Display title everywhere: title, else first non-empty line of text trimmed, else "Untitled" (core.displayTitle).

interface Settings {
  escapeLosesFocus: boolean;       // default false: Esc hides the panel
  hideWhileScreenSharing: boolean; // default false
  zoom: number;                    // default 1.0, range 0.75 to 2.0, step 0.05
  windowAutoSize: boolean;         // default false (first open uses a roomy 640 x 560 pt panel); true: height follows content
  showFormatBar: boolean;          // default false
  countMode: "characters" | "words"; // default "characters"
  panelFrame: { x: number; y: number; width: number; height?: number;
                displays?: { [key: string]: { x: number; y: number } } } | null; // y is the TOP edge; displays keyed "<display uuid>@<w>x<h>"
}
```

The helper stores `NoteContent` verbatim.
**It never parses markdown or ProseMirror JSON**; all derivation happens in core (editor or extension).

## 5. Methods

| Method | Params | Result | Notes |
|---|---|---|---|
| `system.ping` | `{}` | `{ version: string, pid: number }` | Health check; the launcher restarts the helper on a version mismatch |
| `system.shutdown` | `{}` | `{}` | Graceful exit |
| `system.ready` (bridge) | `{}` | `{ settings: Settings, windowData: WindowData }` | Editor finished loading; windowData is for the persisted current note |
| `window.toggle` | `{}` | `{ visible: boolean }` | Show and focus, or hide |
| `window.show` | `{ noteId?: NoteId }` | `{ visible: true }` | Shows the panel, optionally on a note (emits `note.open`) |
| `window.hide` | `{}` | `{ visible: false }` | |
| `window.resize` (bridge) | `{ contentHeight: number, temporary?: boolean }` | `{}` | Content-driven height, clamped 128 to 860 pt times zoom. `temporary: true` (⌘K, browse, dialogs) applies even when windowAutoSize is off and is restored by the next non-temporary report |
| `window.resignFocus` (bridge) | `{}` | `{}` | For the escapeLosesFocus setting: hands focus back to the previous app without hiding |
| `window.setDragRegions` (bridge) | `{ rects: { x: number, y: number, width: number, height: number }[] }` | `{}` | Points (CSS px times zoom), top-left origin, relative to the web view. A mouse down inside drags the window natively (title-bar behavior: it also works as the first click into an unfocused panel) |
| `app.openURL` (bridge) | `{ url: string }` | `{}` | Opens http(s), mailto, and raycast:// links with NSWorkspace |
| `clipboard.copy` (bridge) | `{ text: string, html?: string }` | `{}` | Writes plain text plus optional HTML to the general pasteboard |
| `file.saveAs` (bridge) | `{ suggestedName: string, content: string }` | `{ saved: boolean, path?: string }` | Native save panel; the helper sanitizes the suggested name |
| `notes.create` | `NoteContent & { show?: boolean }` | `Note` | Sets created/updated/lastAccessed to now; becomes the persisted current note; `show` opens the panel on it (emits `note.new`). Callers always send full content built with core |
| `notes.get` | `{ id }` | `Note` | 404 if missing |
| `notes.update` | `{ id, expectedUpdatedAt?: Millis } & Partial<NoteContent> & { caretPosition?: number }` | `{ status: "ok", note: Note } \| { status: "conflict", note: Note }` | Content fields set `updatedAt` to now (always, even if unchanged). Caret-only updates never change `updatedAt` and apply only to live notes. If `expectedUpdatedAt` is given and differs from the stored value, nothing is written and `conflict` returns the stored note |
| `notes.delete` | `{ id }` | `{}` | Soft delete: sets `deletedAt` now, clears `pinned`, `updatedAt` = old + 1 ms |
| `notes.deleteAll` | `{}` | `{ count }` | Same per note for every live note |
| `notes.recover` | `{ id }` | `Note` | Clears `deletedAt` (pin stays cleared), `updatedAt` = old + 1 ms |
| `notes.permanentlyDelete` | `{ id }` | `{}` | Only affects notes already in the trash; no-op on live notes |
| `notes.emptyTrash` | `{}` | `{ count }` | |
| `notes.duplicate` | `{ id, titleSuffix?: string }` | `Note` | Fresh created/updated/lastAccessed, no pin, caret 0; becomes current |
| `notes.pin` | `{ id }` | `Note` | Appends to the end of the pinned list: key = max pinned key + 1000 (first pin 1000). Does not change `updatedAt` |
| `notes.unpin` | `{ id }` | `Note` | Does not change `updatedAt` |
| `notes.movePinnedUp` / `notes.movePinnedDown` | `{ id }` | `{}` | Swap keys with the neighbor pin; no-op at the ends |
| `notes.list` | `{ filter?: string, limit?: number (100), cursor?: string }` | `{ items: NoteSummary[], nextCursor: string \| null }` | Live notes. Order: pinned key asc (pinned first), then `updatedAt` desc, then `id` asc. Used by Search Notes |
| `notes.browse` | `{ filter?: string, limit?: number (100), cursor?: string }` | same shape | Live notes. Order: pinned key asc, then `lastAccessedAt` desc, then `id` asc. With a filter, title matches come before text-only matches (each group in that order). Used by ⌘P |
| `notes.listDeleted` | `{}` | `{ items: (NoteSummary & { markdown: string, rawContent: string })[] }` | All trashed notes, `deletedAt` desc, no paging |
| `notes.count` | `{}` | `{ count: number }` | Live notes |
| `notes.setCurrentNote` | `{ noteId: NoteId }` | `{}` | Persists the current note id (settings key `currentNoteId`) |
| `notes.touchAccessed` | `{ id }` | `{}` | Sets `lastAccessedAt` = now on a live note; no-op otherwise |
| `notes.windowData` | `{ noteId?: NoteId }` | `WindowData` | For that note, or the persisted current note when omitted. If missing or deleted, falls back to the most recently updated live note. `current` is null only when no live notes exist |
| `settings.get` | `{}` | `Settings` | |
| `settings.set` | `Partial<Settings>` | `Settings` | Emits `settings.changed` |

**Filter matching:** case-insensitive substring match on title or text, folding case for all of Unicode and removing diacritics (an intentional improvement over ASCII-only folding).
**Fold rule (exact, identical in TS and Swift):** Unicode NFKD normalization, then remove every scalar whose general category is a mark (Mn, Mc, Me), then lowercase with the root locale (TS `toLowerCase()`, Swift `lowercased()`). Apply the same fold to the query.
**charCount** is the number of Unicode code points in `text` (SQLite `length(text)`, Swift `unicodeScalars.count`). The editor footer counts grapheme clusters separately.
The helper stores folded copies (`title_fold`, `text_fold`) and matches with an escaped `LIKE`.
Cursors are opaque strings encoding the keyset (match group, pin key, order timestamp, id); a cursor is only valid for the source that issued it (helper or read-only fallback).

```ts
interface WindowData {
  current: Note | null;              // null only when no live notes exist
  previousNoteId: NoteId | null;     // newer neighbor in updatedAt desc order
  nextNoteId: NoteId | null;         // older neighbor in updatedAt desc order
  pinnedShortcutNoteIds: NoteId[];   // pin order, at most 9 (⌘1 through ⌘9); ⌘0 is reset zoom
}
```

Purge rule: on startup, and every 24 h while running, notes with `deletedAt` strictly older than now minus 60 days are removed permanently.

**Editor-owned behavior (no helper state):**
- Zoom is applied by the editor in CSS; `window.resize.contentHeight` is in points (CSS px times zoom), measured from the content wrapper (never `documentElement.scrollHeight`).
- While the ⌘K panel, browse, or a dialog is open the editor reports a larger `contentHeight` (about 34rem; 16rem for small popups) and restores it on close; the helper treats every `window.resize` as programmatic (never as a user resize).
- The helper provides a standard Edit menu (⌘C, ⌘X, ⌘V, ⌘Z, ⇧⌘Z, ⌘A) and maps ⇧⌘V to a real paste event in the web view; the editor turns that paste into plain text and never reads the clipboard itself.
- The panel is borderless: the editor draws its own Close control (`window.hide`) and the hover-only chrome. ⌘W hides the panel (helper menu item, like closing a window in any app).
- The helper gives the borderless panel generous resize hit zones: 8 pt along edges and 16 pt squares at corners, with the matching resize cursors. The panel has no `.resizable` style; these zones do all user resizing, and the top 8 pt of the drag strip is a resize zone. Keep interactive controls at least 16 pt from the panel corners.
- Temporary growth only grows: if the panel is already at least the requested height, nothing changes (so ⌘K and browse never resize a roomy window).
- The editor owns the body tint (a darker, less transparent background for contrast); the helper keeps the vibrancy material underneath. Minimum user size is 396 pt wide by 128 pt times zoom.
- The editor measures height directly in its ResizeObserver callback (not in requestAnimationFrame, which hidden WebKit windows pause), so the prewarmed panel is sized before it shows; a one-line note reports about 135 pt with the footer at the bottom.
- Helper test-only flags: `--test-hooks` enables `test.*` socket methods.
- The helper overlays an invisible 12 pt drag strip along the panel's top edge; the editor keeps about 12 pt of non-interactive top padding.
- Back/forward history is two in-memory stacks in the editor (cap 100). Switching notes pushes the old current note on the back stack (skipping duplicates of the top) and clears forward. When a stack is empty, back goes to `previousNoteId` and forward to `nextNoteId`. Deleted ids are removed from both stacks.
- Every switch calls `notes.touchAccessed` and `notes.setCurrentNote` after flushing pending edits (a failed flush cancels the switch).
- ⌘N on a note whose text is blank only shows a "You already have an empty note" notice.
- When `current` is null the editor creates a note immediately from the empty document.
- Deleting the current note opens `nextNoteId`, else `previousNoteId`, else creates a fresh empty note. Delete All leaves one fresh empty note and clears history.
- Content autosave and caret save are debounced 300 ms and flushed on switch, hide, and blur.

## 6. Database schema (owned by the helper)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
-- PRAGMA user_version tracks migrations; version 1 is:

CREATE TABLE notes (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL DEFAULT '',
  text             TEXT NOT NULL DEFAULT '',
  markdown         TEXT NOT NULL DEFAULT '',
  raw_content      TEXT NOT NULL,
  title_fold       TEXT NOT NULL DEFAULT '',  -- folded copies for filter matching
  text_fold        TEXT NOT NULL DEFAULT '',
  pinned           REAL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  last_accessed_at INTEGER,
  caret_position   INTEGER
) STRICT, WITHOUT ROWID;

CREATE INDEX notes_list_order   ON notes (deleted_at, pinned, updated_at DESC, id);
CREATE INDEX notes_browse_order ON notes (deleted_at, pinned, last_accessed_at DESC, id);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
```

The extension may open the database **read-only** (`node:sqlite`, `readOnly: true`) for instant lists and search when the helper is not running.
All writes go through the helper.

## 7. @overnote/core API (TypeScript, runs in the browser and in Node 22 with no DOM)

```ts
export const headlessExtensions: AnyExtension[];    // schema, input rules, serializers; runs in Node with no DOM (schema source of truth)
// the editor adds its own DOM-only extensions (lowlight node view, slash and emoji menus, find highlighting) on top
// lists use prosemirror-flat-list: one `list` node per item, attrs kind (bullet|ordered|task|toggle), order, checked, collapsed;
// content "(paragraph|list) block*"; headings 1 to 3; codeBlock.language string|null; link attrs href,title (non-inclusive);
// unknown nodes/marks are preserved as placeholder nodes/marks
export function getNoteSchema(): Schema;
export function emptyDoc(): JSONContent;
export function markdownToDoc(markdown: string, opts?: { mode?: "import" | "paste" }): JSONContent; // always >= one paragraph; handles inline <strong><b><em><i><u><s><del><code><a><br> without a DOM
export function docToMarkdown(doc: JSONContent): string;
export function docToPlainText(doc: JSONContent): string;
export function docToHTML(doc: JSONContent): string;                     // semantic export HTML (ul/ol/li), no wrapper; empty doc is <p></p>
// all serializers return no trailing newline; docToMarkdown output is stable under parse then serialize
export function deriveTitle(doc: JSONContent): string;        // first line of plain text, trimmed
export function displayTitle(n: { title: string; text: string }): string; // title, else first non-empty text line trimmed, else "Untitled"
export function buildNoteContent(doc: JSONContent): NoteContent; // rawContent + markdown + text + title
export function noteContentFromMarkdown(markdown: string): NoteContent;
export function loadDoc(rawContent: string | null, text: string): JSONContent; // stored doc if valid (placeholders preserved), else rebuild from text with a hard break per newline
export function toStoredDoc(doc: JSONContent): JSONContent;               // inverse of loadDoc's placeholder mapping
export function docToClipboard(docOrSlice: JSONContent): { text: string; html: string };   // ⌘C/⌘X format (spec/serialization.md section 6)
export function derivePreview(text: string): string;                     // first 200 chars, newlines collapsed to spaces
export function parsePastedText(plain: string, html?: string): JSONContent;
export function looksLikeMarkdown(plain: string, html?: string): boolean;
export function normalizeLinkHref(input: string): string | null;
export function countCharacters(text: string): number;                   // grapheme clusters of trimmed text
export function countWords(text: string): number;                        // Intl.Segmenter word segments
export type { Note, NoteSummary, NoteContent, Settings, WindowData, NoteId } from "./types";
export * as rpc from "./rpc";
// Light entry point `@overnote/core/text` exports types, rpc, displayTitle, derivePreview, countCharacters, countWords and fold, with no Tiptap import (for list commands and the menu bar)   // method name constants and param/result types from section 5
```

## 8. Extension commands (package.json)

| name | title | mode | notes |
|---|---|---|---|
| `toggle-notes` | Toggle Overnote | no-view | Launch the helper if needed, then `window.toggle` |
| `create-note` | Create Note | no-view | Optional `text` argument, then `fallbackText`, then selected text, then empty. `notes.create` with `show: true` |
| `search-notes` | Search Notes | view | List with markdown detail using `notes.list` with `filter` (or the read-only DB with the same order and matching); title matches are moved first within each page; writes through the helper |
| `recently-deleted` | Recently Deleted Notes | view | Recover, delete permanently, empty trash |
| `menu-bar` | Overnote Menu Bar | menu-bar | `interval: "1m"`, `disabledByDefault: true`; pinned and recent notes, new note; restarts a dead helper |

No default hotkeys.

Launch context: `toggle-notes` accepts `launchContext: { id?: NoteId }` (shows that note via `window.show`), and `create-note` accepts `launchContext: { text?: string }`.
This lets deeplinks and quicklinks open a specific note or create one with text.

## Changelog

- v2.8 (2026-10-15): from the user's visual review, windowAutoSize defaults off with a 640 x 560 pt first-open size; `window.setDragRegions`; ⌘W hides; larger resize hit zones; temporary growth never shrinks or resizes a big-enough panel; editor-owned darker body tint.

- v2.7 (2026-10-14): per-display positions in panelFrame, `window.resize.temporary`, borderless panel with editor-drawn Close, ResizeObserver measuring, test hooks.

- v2.6 (2026-10-14): bridge `app.openURL`; `listDeleted` rows include `rawContent`; editor-driven temporary growth through `window.resize` (no separate minimum-height method); Edit menu and ⇧⌘V paste event. Deferred: ⌘, settings and ⇧⌘L quicklink from inside the panel.

- v2.5 (2026-10-14): from the helper build, panelFrame.y is the top edge, error code details, update timestamp rule, `--headless`, editor-owned zoom and contentHeight measurement, 12 pt drag strip.

- v2.4 (2026-10-14): exact fold rule shared by TS and Swift, charCount in code points, source-bound cursors, displayTitle skips empty lines, light `@overnote/core/text` entry point.

- v2.3 (2026-10-14): from spec/serialization.md, accepted deviations D1 to D19 (fix Raycast's round-trip bugs; headings 4 to 6 become level 3); markdownToDoc mode option; loadDoc nullable with hard-break fallback; docToClipboard returns {text, html}; derivePreview; semantic HTML; no trailing newlines.

- v2.2 (2026-10-14): from spec/editor.md, the flat-list schema, a headless/editor extension split, title skips empty blocks with no cap, and new core helpers (loadDoc, toStoredDoc, docToClipboard, parsePastedText, looksLikeMarkdown, normalizeLinkHref, countCharacters, countWords).

- v2.1 (2026-10-14): from spec/keymap.md, added `windowAutoSize`, a 0.75 to 2.0 zoom range, `panelFrame.height`, bridge `clipboard.copy` and `file.saveAs`, `notes.duplicate` `titleSuffix`, and launch contexts for `toggle-notes` and `create-note`.

- v2 (2026-10-14): split `notes.list` / `notes.browse` with substring `filter` (Unicode and diacritic folding) and removed `notes.search` and FTS5; WindowData now carries neighbor ids and up to 9 pin shortcuts; history moved into the editor (removed `notes.navigate` and history tables); `notes.setCurrent` split into `notes.setCurrentNote` and `notes.touchAccessed`; `notes.windowData` takes an optional `noteId`; pin appends with +1000 keys and gained `movePinnedUp`/`movePinnedDown` (dropped `beforeId`); delete clears pins and steps `updatedAt` by 1 ms; optimistic `expectedUpdatedAt` on update with a conflict result; `permanentlyDelete` only on trashed notes; `listDeleted` unpaged with markdown; `charCount` on NoteSummary; title is the first line of plain text with `displayTitle` fallback.
