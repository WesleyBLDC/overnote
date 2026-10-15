# Component contract (v2)

v2 (2026-10-14) applies spec/data.md section 11; see the changelog at the end.

This is the single source of truth for how the four components talk to each other.
Change it only through the orchestrator; if you need a change, write it in your final report under "Contract change requests" and implement against the current version meanwhile.

```
Raycast extension (src/)  ──socket JSON-RPC──▶  BetterNotesHelper (helper/)
                                                   │  WKScriptMessageHandler bridge
@better-notes/core (packages/core/)  ◀── used by ──┴─ editor (editor/) running in WKWebView
```

## 1. Files and paths

| Thing | Path |
|---|---|
| Extension root | repo root (`package.json` is the Raycast manifest) |
| Helper binary (built) | `assets/bin/BetterNotesHelper` (universal, ad-hoc signed) plus `assets/bin/BetterNotesHelper.sha256` |
| Editor build | `assets/editor/` (`index.html` plus relative assets; Vite `base: "./"`) |
| Data dir | `environment.supportPath` of the extension, passed to the helper as `--support-dir` |
| Database | `<support-dir>/notes.sqlite` (WAL) |
| Socket | `/tmp/better-notes-<uid>/helper.sock`; the directory is created with mode 0700 by whoever starts first |
| PID file | `/tmp/better-notes-<uid>/helper.pid` |
| Helper log | `<support-dir>/helper.log` (rotated at 1 MB) |

Helper command line:

```
BetterNotesHelper --support-dir <dir> --socket <path> --pid-file <path> --editor-dir <assets/editor> [--show] [--version]
```

`--version` prints the version string and exits.
`--show` shows the panel right after startup.

## 2. Wire protocol (socket)

- Unix domain stream socket, UTF-8, one JSON object per line (`\n` terminated).
- Request: `{"id": <int|string>, "method": "<name>", "params": {...}}`.
- Response: `{"id": ..., "result": ...}` or `{"id": ..., "error": {"code": <int>, "message": "<text>"}}`.
- Many requests may be in flight on one connection; responses can arrive out of order and are matched by `id`.
- Error codes: `-32601` unknown method, `-32602` bad params, `404` note not found, `409` conflict, `500` internal.
- Clients must time out after 3 s (10 s for `system.shutdown`).

## 3. Bridge protocol (editor ⇄ helper)

- Web to native: `window.webkit.messageHandlers.betterNotes.postMessage({ id, method, params })`.
- Native to web replies: the helper calls `window.betterNotesBridge.resolve(id, result)` or `window.betterNotesBridge.reject(id, { code, message })`.
- Native to web events: `window.betterNotesBridge.emit(event, payload)`.
- The editor must define `window.betterNotesBridge` before it sends anything.
  When it is ready it calls `system.ready`.
- **The same method names and shapes as the socket**, served by one dispatcher in the helper.
  Bridge-only methods are marked (bridge) below.
- Assets are served from the custom scheme `betternotes://app/` (for example `betternotes://app/index.html`), mapped to `--editor-dir`.

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
  markdown: string;            // derived by @better-notes/core
  text: string;                // plain text, derived by core
  title: string;               // derived by core: first line of the plain text, trimmed (may be empty)
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
// Display title everywhere: title, else first line of text trimmed, else "Untitled" (core.displayTitle).

interface Settings {
  escapeLosesFocus: boolean;       // default false: Esc hides the panel
  hideWhileScreenSharing: boolean; // default false
  zoom: number;                    // default 1.0, range 0.5 to 2.0
  showFormatBar: boolean;          // default false
  countMode: "characters" | "words"; // default "characters"
  panelFrame: { x: number; y: number; width: number } | null;
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
| `window.resize` (bridge) | `{ contentHeight: number }` | `{}` | Content-driven height; the helper clamps it to screen bounds |
| `window.resignFocus` (bridge) | `{}` | `{}` | For the escapeLosesFocus setting: hands focus back to the previous app without hiding |
| `notes.create` | `NoteContent & { show?: boolean }` | `Note` | Sets created/updated/lastAccessed to now; becomes the persisted current note; `show` opens the panel on it (emits `note.new`). Callers always send full content built with core |
| `notes.get` | `{ id }` | `Note` | 404 if missing |
| `notes.update` | `{ id, expectedUpdatedAt?: Millis } & Partial<NoteContent> & { caretPosition?: number }` | `{ status: "ok", note: Note } \| { status: "conflict", note: Note }` | Content fields set `updatedAt` to now (always, even if unchanged). Caret-only updates never change `updatedAt` and apply only to live notes. If `expectedUpdatedAt` is given and differs from the stored value, nothing is written and `conflict` returns the stored note |
| `notes.delete` | `{ id }` | `{}` | Soft delete: sets `deletedAt` now, clears `pinned`, `updatedAt` = old + 1 ms |
| `notes.deleteAll` | `{}` | `{ count }` | Same per note for every live note |
| `notes.recover` | `{ id }` | `Note` | Clears `deletedAt` (pin stays cleared), `updatedAt` = old + 1 ms |
| `notes.permanentlyDelete` | `{ id }` | `{}` | Only affects notes already in the trash; no-op on live notes |
| `notes.emptyTrash` | `{}` | `{ count }` | |
| `notes.duplicate` | `{ id }` | `Note` | Fresh created/updated/lastAccessed, no pin, caret 0; becomes current |
| `notes.pin` | `{ id }` | `Note` | Appends to the end of the pinned list: key = max pinned key + 1000 (first pin 1000). Does not change `updatedAt` |
| `notes.unpin` | `{ id }` | `Note` | Does not change `updatedAt` |
| `notes.movePinnedUp` / `notes.movePinnedDown` | `{ id }` | `{}` | Swap keys with the neighbor pin; no-op at the ends |
| `notes.list` | `{ filter?: string, limit?: number (100), cursor?: string }` | `{ items: NoteSummary[], nextCursor: string \| null }` | Live notes. Order: pinned key asc (pinned first), then `updatedAt` desc, then `id` asc. Used by Search Notes |
| `notes.browse` | `{ filter?: string, limit?: number (100), cursor?: string }` | same shape | Live notes. Order: pinned key asc, then `lastAccessedAt` desc, then `id` asc. With a filter, title matches come before text-only matches (each group in that order). Used by ⌘P |
| `notes.listDeleted` | `{}` | `{ items: (NoteSummary & { markdown: string })[] }` | All trashed notes, `deletedAt` desc, no paging |
| `notes.count` | `{}` | `{ count: number }` | Live notes |
| `notes.setCurrentNote` | `{ noteId: NoteId }` | `{}` | Persists the current note id (settings key `currentNoteId`) |
| `notes.touchAccessed` | `{ id }` | `{}` | Sets `lastAccessedAt` = now on a live note; no-op otherwise |
| `notes.windowData` | `{ noteId?: NoteId }` | `WindowData` | For that note, or the persisted current note when omitted. If missing or deleted, falls back to the most recently updated live note. `current` is null only when no live notes exist |
| `settings.get` | `{}` | `Settings` | |
| `settings.set` | `Partial<Settings>` | `Settings` | Emits `settings.changed` |

**Filter matching:** case-insensitive substring match on title or text, folding case for all of Unicode and removing diacritics (an intentional improvement over ASCII-only folding).
The helper stores folded copies (`title_fold`, `text_fold`) and matches with an escaped `LIKE`.
Cursors are opaque strings encoding the keyset (match group, pin key, order timestamp, id).

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

## 7. @better-notes/core API (TypeScript, runs in the browser and in Node 22 with no DOM)

```ts
export const extensions: AnyExtension[];            // the Tiptap extension list both sides use (schema source of truth)
export function getNoteSchema(): Schema;
export function emptyDoc(): JSONContent;
export function markdownToDoc(markdown: string): JSONContent;
export function docToMarkdown(doc: JSONContent): string;
export function docToPlainText(doc: JSONContent): string;
export function docToHTML(doc: JSONContent): string;
export function deriveTitle(doc: JSONContent): string;        // first line of plain text, trimmed
export function displayTitle(n: { title: string; text: string }): string; // title, else first text line, else "Untitled"
export function buildNoteContent(doc: JSONContent): NoteContent; // rawContent + markdown + text + title
export function noteContentFromMarkdown(markdown: string): NoteContent;
export type { Note, NoteSummary, NoteContent, Settings, WindowData, NoteId } from "./types";
export * as rpc from "./rpc";   // method name constants and param/result types from section 5
```

## 8. Extension commands (package.json)

| name | title | mode | notes |
|---|---|---|---|
| `toggle-notes` | Toggle Better Notes | no-view | Launch the helper if needed, then `window.toggle` |
| `create-note` | Create Note | no-view | Optional `text` argument, then `fallbackText`, then selected text, then empty. `notes.create` with `show: true` |
| `search-notes` | Search Notes | view | List with markdown detail using `notes.list` with `filter` (or the read-only DB with the same order and matching); title matches are moved first within each page; writes through the helper |
| `recently-deleted` | Recently Deleted Notes | view | Recover, delete permanently, empty trash |
| `menu-bar` | Better Notes Menu Bar | menu-bar | `interval: "1m"`, `disabledByDefault: true`; pinned and recent notes, new note; restarts a dead helper |

No default hotkeys.

## Changelog

- v2 (2026-10-14): split `notes.list` / `notes.browse` with substring `filter` (Unicode and diacritic folding) and removed `notes.search` and FTS5; WindowData now carries neighbor ids and up to 9 pin shortcuts; history moved into the editor (removed `notes.navigate` and history tables); `notes.setCurrent` split into `notes.setCurrentNote` and `notes.touchAccessed`; `notes.windowData` takes an optional `noteId`; pin appends with +1000 keys and gained `movePinnedUp`/`movePinnedDown` (dropped `beforeId`); delete clears pins and steps `updatedAt` by 1 ms; optimistic `expectedUpdatedAt` on update with a conflict result; `permanentlyDelete` only on trashed notes; `listDeleted` unpaged with markdown; `charCount` on NoteSummary; title is the first line of plain text with `displayTitle` fallback.
