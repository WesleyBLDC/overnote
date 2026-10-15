# Component contract (v1)

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
  title: string;               // derived by core: first non-empty line, trimmed, max 100 chars
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
  pinned: number | null; createdAt: Millis; updatedAt: Millis;
  deletedAt: Millis | null; lastAccessedAt: Millis | null;
}

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
| `system.ready` (bridge) | `{}` | `{ settings: Settings, windowData: WindowData }` | Editor finished loading |
| `window.toggle` | `{}` | `{ visible: boolean }` | Show and focus, or hide |
| `window.show` | `{ noteId?: NoteId }` | `{ visible: true }` | Shows the panel, optionally on a note (emits `note.open`) |
| `window.hide` | `{}` | `{ visible: false }` | |
| `window.resize` (bridge) | `{ contentHeight: number }` | `{}` | Content-driven height; the helper clamps it to screen bounds |
| `window.resignFocus` (bridge) | `{}` | `{}` | For the escapeLosesFocus setting: hands focus back to the previous app without hiding |
| `notes.create` | `NoteContent & { show?: boolean }` | `Note` | Becomes the current note; `show` opens the panel on it |
| `notes.get` | `{ id }` | `Note` | 404 if missing |
| `notes.update` | `{ id } & Partial<NoteContent> & { caretPosition?: number }` | `Note` | Bumps `updatedAt` only when content fields change |
| `notes.delete` | `{ id }` | `{}` | Soft delete (sets `deletedAt`) |
| `notes.deleteAll` | `{}` | `{ count }` | Soft deletes every non-deleted note |
| `notes.recover` | `{ id }` | `Note` | Clears `deletedAt` |
| `notes.permanentlyDelete` | `{ id }` | `{}` | |
| `notes.emptyTrash` | `{}` | `{ count }` | |
| `notes.duplicate` | `{ id }` | `Note` | The copy becomes current |
| `notes.pin` | `{ id, beforeId?: NoteId }` | `Note` | Without `beforeId` it is appended to the end of the pinned list |
| `notes.unpin` | `{ id }` | `Note` | |
| `notes.list` | `{ limit?: number (50), cursor?: string, includeDeleted?: false }` | `{ items: NoteSummary[], nextCursor: string \| null }` | Order: pinned (by `pinned` asc), then the rest by `lastAccessedAt` desc, then `updatedAt` desc |
| `notes.listDeleted` | `{ limit?, cursor? }` | same shape | Ordered by `deletedAt` desc |
| `notes.search` | `{ query: string, limit?: number (50) }` | `{ items: (NoteSummary & { snippet: string })[] }` | FTS5 over title and text, prefix matching, title hits ranked first |
| `notes.count` | `{}` | `{ count: number }` | Non-deleted notes |
| `notes.setCurrent` | `{ id }` | `WindowData` | Records a visit in history and touches `lastAccessedAt` |
| `notes.navigate` | `{ direction: "back" \| "forward" }` | `WindowData` | Moves through the visit history (persisted) |
| `notes.windowData` | `{}` | `WindowData` | |
| `settings.get` | `{}` | `Settings` | |
| `settings.set` | `Partial<Settings>` | `Settings` | Emits `settings.changed` |

```ts
interface WindowData {
  current: Note | null;          // null when there are no notes
  canGoBack: boolean;
  canGoForward: boolean;
  pinned: NoteSummary[];         // in pin order, at most 10 (⌘0 through ⌘9)
  count: number;
}
```

Purge rule: on startup, and every 24 h while running, notes with `deletedAt` older than 60 days are removed permanently.

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
  pinned           REAL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  last_accessed_at INTEGER,
  caret_position   INTEGER
) STRICT, WITHOUT ROWID;

CREATE INDEX notes_active_order ON notes (deleted_at, pinned, last_accessed_at DESC, updated_at DESC);

CREATE VIRTUAL TABLE notes_fts USING fts5 (id UNINDEXED, title, text, tokenize = 'unicode61 remove_diacritics 2');
-- kept in sync by the repository inside the same transaction as each write

CREATE TABLE history (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  visited_at INTEGER NOT NULL
);
CREATE TABLE history_cursor (k INTEGER PRIMARY KEY CHECK (k = 1), seq INTEGER);

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
export function deriveTitle(doc: JSONContent): string;
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
| `search-notes` | Search Notes | view | List with markdown detail; reads directly (read-only DB) and writes through the helper |
| `recently-deleted` | Recently Deleted Notes | view | Recover, delete permanently, empty trash |
| `menu-bar` | Better Notes Menu Bar | menu-bar | `interval: "1m"`, `disabledByDefault: true`; pinned and recent notes, new note; restarts a dead helper |

No default hotkeys.
