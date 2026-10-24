# Architecture and protocol

This is the contributor reference for how Overnote's four components fit together and talk to each other: file paths, the socket and bridge protocols, shared data types, RPC methods, the database schema, the `@overnote/core` API, and the extension commands.
The current protocol version is v3.3 (see [Protocol versioning](#protocol-versioning)).
Code and this document change together: if a pull request changes a method, a type, a path, or the schema, it updates this file too.

```
Raycast extension (src/)  ──socket JSON-RPC──▶  OvernoteHelper (helper/)
                                                   │  WKScriptMessageHandler bridge
@overnote/core (packages/core/)  ◀── used by ──┴─ editor (editor/) running in WKWebView
```

## 1. Files and paths

| Thing | Path |
|---|---|
| Extension root | repo root (`package.json` is the Raycast manifest) |
| Helper binary (built) | `assets/bin/OvernoteHelper` (arm64, ad-hoc signed) plus `assets/bin/OvernoteHelper.sha256` |
| Editor build | `assets/editor/` (`index.html` plus relative assets; Vite `base: "./"`) |
| Data dir | `environment.supportPath` of the extension, passed to the helper as `--support-dir` |
| Database | `<support-dir>/notes.sqlite` (WAL) |
| Socket | `/tmp/overnote-<uid>/helper.sock`; the directory is created with mode 0700 by whoever starts first |
| PID file | `/tmp/overnote-<uid>/helper.pid` |
| Helper log | `<support-dir>/helper.log` (rotated at 1 MB) |
| Backups | `~/Library/Application Support/Overnote/backups/` (mode 0700), outside the extension; `OVERNOTE_BACKUP_DIR` overrides it (see [section 9](#9-backups-installs-and-updates)) |
| Release marker | `assets/prebuilt.json` in a release install: `{ version, schemaVersion, commit, helperVersion, helperSha256 }` |
| Install location | `assets/install-location.json`: `{ installDir }`, written by `scripts/install-extension.sh` for Check for Updates |
| Development assets | `assets/dev.json`: `{ assetsDir }`, written by `scripts/dev.sh`; a development build (`environment.isDevelopment`) without `assets/prebuilt.json` runs the helper and editor from that folder |
| Launch record | `/tmp/overnote-<uid>/helper-launch.json`: `{ pid, key }`, the helper the launcher last started and what it started it with |

Helper command line:

```
OvernoteHelper --support-dir <dir> --socket <path> --pid-file <path> --editor-dir <assets/editor> [--show] [--watch-editor] [--version] [--schema-version]
```

`--version` prints the version string and exits.
`--schema-version` prints the database schema version this helper writes (the latest migration) and exits.
The helper reads `OVERNOTE_BACKUP_DIR` from its environment for the backups folder; tests always set it to a temporary folder.
`--show` shows the panel right after startup.
`--watch-editor` (development only) checks `<editor-dir>/index.html` twice a second; when a new build has settled it emits `editor.willReload`, and reloads the page itself if the editor has not reloaded within 2 s.

## 2. Wire protocol (socket)

- Unix domain stream socket, UTF-8, one JSON object per line (`\n` terminated).
- Request: `{"id": <int|string>, "method": "<name>", "params": {...}}`.
- Response: `{"id": ..., "result": ...}` or `{"id": ..., "error": {"code": <int>, "message": "<text>"}}`.
- Many requests may be in flight on one connection; responses can arrive out of order and are matched by `id`.
- Error codes: `-32700` unparseable JSON (with `id: null`), `-32601` unknown method (also bridge-only methods on the socket and socket-only methods on the bridge), `-32602` bad params, `404` note or backup not found, `409` invalid state (for example pin or move on a trashed or unpinned note, or a backup with a newer schema), `500` internal.
- `touchAccessed` on a missing id is a silent no-op; `permanentlyDelete` on a missing id is 404; `window.show {noteId}` is 404 for a missing note and persists it as current.
- `notes.update` sets `updatedAt` to max(now, old + 1) so same-millisecond edits still change it.
- The helper also accepts `--headless` (no window) for smoke tests.
- Clients must time out after 3 s (10 s for `system.shutdown`, 60 s for `system.backup` and `system.restoreBackup`, and 30 min for `file.saveAs`, which waits for the person in a save panel).

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
| `window.didResignKey` | `{}` | The panel lost focus |
| `note.open` | `{ id: string }` | An external caller asked to show a specific note |
| `note.new` | `{ note: Note }` | An external caller created a note and asked to show it |
| `notes.changed` | `{ ids: string[] }` | Data changed through the socket (so the editor reloads, or merges into unsaved edits) |
| `settings.changed` | `Settings` | A setting changed |
| `editor.willReload` | `{}` | Development only (`--watch-editor`): a new editor build landed; the editor saves, then reloads the page |

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
                displays?: { [key: string]: PanelPoint } } | null; // y is the TOP edge; displays keyed "<display uuid>@<w>x<h>"
}

type PanelPlacement = "left" | "right" | "fill" | "center";

interface PanelPoint {             // one display's remembered top left point; y is the TOP edge
  x: number; y: number;
  width?: number; height?: number; // the placed size, stored with placement by window.place
  placement?: PanelPlacement;      // run again when the panel opens on that display
}
```

A display point stored before v3.3 has only `x` and `y`, and reads and writes back unchanged until a placement is stored for that display.

The helper stores `NoteContent` verbatim.
**It never parses markdown or ProseMirror JSON**; all derivation happens in core (editor or extension).

## 5. Methods

| Method | Params | Result | Notes |
|---|---|---|---|
| `system.ping` | `{}` | `{ version: string, pid: number }` | Health check; the launcher restarts the helper on a version mismatch, and when the launch record does not match the running pid, the binary's checksum, and the launch arguments |
| `system.shutdown` | `{}` | `{}` | Graceful exit |
| `system.status` (socket) | `{}` | `SystemStatus` | Version, schema, note and backup counts, and the restore offer (section 9) |
| `system.backup` (socket) | `{ reason?: BackupReason }` (default `"manual"`) | `BackupInfo` | Writes a backup now, even of an empty database, then prunes old ones |
| `system.listBackups` (socket) | `{}` | `{ directory: string, items: BackupInfo[] }` | Newest first; other files in the folder are ignored |
| `system.restoreBackup` (socket) | `{ path: string }` | `{ restored: BackupInfo, preRestoreBackup: BackupInfo, noteCount: number }` | Only a backup file directly inside the backups folder (symlinks and `..` resolved first), else `-32602`; `404` when missing. Backs up the current database (reason `pre-restore`), copies the backup into the live connection, migrates it if older, clears the restore offer, and emits `notes.changed` with every note id. A damaged backup is `-32602`, a newer schema `409` |
| `system.dismissRestoreOffer` (socket) | `{}` | `{}` | Clears the restore offer |
| `system.ready` (bridge) | `{}` | `{ settings: Settings, windowData: WindowData }` | Editor finished loading; windowData is for the persisted current note |
| `window.toggle` | `{}` | `{ visible: boolean }` | Show and focus, or hide |
| `window.show` | `{ noteId?: NoteId }` | `{ visible: true }` | Shows the panel, optionally on a note (emits `note.open`) |
| `window.hide` | `{}` | `{ visible: false }` | |
| `window.place` | `{ placement: PanelPlacement }` | `{ placement: PanelPlacement, frame: { x, y, width, height } }` | Places the panel inside the visible frame of its display while it is visible, else of the display under the pointer, without showing it (see below). `frame` is in points in the panelFrame convention: `x` is the left edge and `y` the top edge. Any other placement is `-32602` |
| `window.resize` (bridge) | `{ contentHeight: number, temporary?: boolean }` | `{}` | Content-driven height, clamped from the minimum size (see `window.setMinimumSize`) to 860 pt times zoom. `temporary: true` (confirmation dialogs; panels and dropdowns stay inside the panel instead) applies even when windowAutoSize is off and is restored by the next non-temporary report |
| `window.setMinimumSize` (bridge) | `{ width: number, height: number }` | `{}` | The smallest the panel may be, in points: the editor's toolbar (its controls plus 6rem for the title), its bottom bar (the counter or the format bar), and one line of note text, at the current zoom. The helper rounds up and never goes below 405 by 197 pt, applies it to user resizing, auto-sizing, temporary growth, and restored frames, and grows a smaller panel at once, keeping its top edge. `-32602` unless both are positive numbers |
| `window.resignFocus` (bridge) | `{}` | `{}` | For the escapeLosesFocus setting: hands focus back to the previous app without hiding |
| `window.setDragRegions` (bridge) | `{ rects: { x: number, y: number, width: number, height: number }[] }` | `{}` | Points (CSS px times zoom), top-left origin, relative to the web view. A mouse down inside drags the window natively (title-bar behavior: it also works as the first click into an unfocused panel) |
| `app.openURL` (bridge) | `{ url: string }` | `{}` | Opens http(s), mailto, and raycast:// links with NSWorkspace |
| `clipboard.copy` (bridge) | `{ text: string, html?: string }` | `{}` | Writes plain text plus optional HTML to the general pasteboard |
| `file.saveAs` (bridge) | `{ suggestedName: string, content: string }` | `{ saved: boolean, path?: string }` | Native save panel; the helper sanitizes the suggested name and keeps it within 240 UTF-8 bytes, extension included |
| `notes.create` | `NoteContent & { show?: boolean }` | `Note` | Sets created/updated/lastAccessed to now. Only with `show: true` does it become the persisted current note and open the panel on it (emits `note.new`); without `show` the current note stays as it was, so a background write never moves the note the panel opens on. Callers always send full content built with core |
| `notes.get` | `{ id }` | `Note` | 404 if missing |
| `notes.update` | `{ id, expectedUpdatedAt?: Millis } & Partial<NoteContent> & { caretPosition?: number }` | `{ status: "ok", note: Note } \| { status: "conflict", note: Note }` | Content fields set `updatedAt` to now (always, even if unchanged). Caret-only updates never change `updatedAt` and apply only to live notes. If `expectedUpdatedAt` is given and differs from the stored value, nothing is written and `conflict` returns the stored note |
| `notes.delete` | `{ id }` | `{}` | Soft delete: sets `deletedAt` now, clears `pinned`, `updatedAt` = old + 1 ms |
| `notes.deleteAll` | `{}` | `{ count }` | Same per note for every live note |
| `notes.recover` | `{ id }` | `Note` | Clears `deletedAt` (pin stays cleared), `updatedAt` = old + 1 ms |
| `notes.permanentlyDelete` | `{ id }` | `{}` | Only affects notes already in the trash; no-op on live notes |
| `notes.emptyTrash` | `{}` | `{ count }` | |
| `notes.duplicate` | `{ id } \| { id } & NoteContent` | `Note` | Fresh created/updated/lastAccessed, no pin, caret 0. With only `id` the copy has the source's content verbatim. With content (`rawContent` required, as in `notes.create`), the copy stores that content instead, still verbatim: a caller that renames the copy builds it with core's `duplicateContent`, so the title and the first line agree (see below). `titleSuffix` was removed in v3.0 and is refused with `-32602`, as is content without `rawContent`; 404 if the source is missing. The current note stays as it was; a caller that opens the copy persists it with `notes.setCurrentNote` (the editor's ⌘D and Search Notes' Duplicate do) or shows it with `window.show { noteId }` |
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
| `settings.reset` | `{}` | `Settings` | Deletes every stored setting so each reads as its default (the panel frame included, so the panel returns to its first open size and place); the current note and the restore offer stay. Emits `settings.changed` |

**Duplicate titles:** a copy's title is never changed apart from its document, since the title is derived from the first line and the next content save would derive it again.
Search Notes' Duplicate adds the suffix " (Copy)" by sending `duplicateContent(source, " (Copy)")` with `notes.duplicate`.
`duplicateContent` inserts the suffix as plain text into the line the title comes from: the first textblock with any text (empty blocks are skipped, as in the title rule), right after the last non-space character before its first hard break or newline, or at the start of that line when it is blank (the suffix's leading spaces are then dropped).
Every field is then derived from the suffixed document, so `title`, `rawContent`, `markdown`, `text`, and the helper's `title_fold` agree, and previews show the suffixed first line.
For example `# Groceries` becomes `# Groceries (Copy)`, and `**Plan**` becomes `**Plan** (Copy)`.
The editor's ⌘D sends only `id` and makes an exact copy, with no suffix.

**Filter matching:** case-insensitive substring match on title or text, folding case for all of Unicode and removing diacritics (an intentional improvement over ASCII-only folding).
**Fold rule (exact, identical in TS and Swift):** Unicode NFKD normalization, then remove every scalar whose general category is a mark (Mn, Mc, Me), then lowercase with the root locale (TS `toLowerCase()`, Swift `lowercased()`).
Apply the same fold to the query.
Both implementations are checked against one shared golden corpus in `packages/core/tests/fold-corpus.json`, covering accents, case, compatibility characters, combining marks, and emoji.
**charCount** is the number of Unicode code points in `text` (SQLite `length(text)`, Swift `unicodeScalars.count`).
The editor footer counts grapheme clusters separately.
The helper stores folded copies (`title_fold`, `text_fold`) and matches with an escaped `LIKE`.
Schema version 2 adds an FTS5 trigram index over the folded copies, kept in sync by triggers, plus virtual generated sort columns and paging indexes over them that match the list and browse paging order, so a keyset cursor seeks straight to its page.
A filtered query whose folded term has at least three Unicode scalars uses the index only to narrow the candidate set, then applies the same escaped `LIKE` predicate to those candidates, so the results are exactly the folded substring results.
Shorter terms keep the folded `LIKE` scan by design, since the trigram tokenizer cannot index them.
Where FTS5 or the trigram tokenizer is unavailable, version 2 applies without the index, and when a `MATCH` fails at query time the helper stops using the index until it restarts; both keep the folded `LIKE` scan.
Ordering does not change: the index never ranks results, and list and browse keep the order stated for each method above, including title matches before text only matches in a filtered browse.
The read-only fallback mirrors that query shape: on a database with `notes_fts` it narrows with the index and applies the same `LIKE` recheck, on a database with the paging indexes it spells the order over the generated sort columns, and on a schema version 1 or indexless database it keeps the pure folded `LIKE` scan.
A SQLite built without FTS5, such as the system `sqlite3` on some macOS versions, still reads and backs up a schema version 2 database, because only a statement that touches `notes_fts` needs the module; the fallback treats that failed `MATCH` like any other and keeps the `LIKE` scan.
Writing `notes` fires the index triggers, so only a SQLite with FTS5 can write it: the helper, which created the index, and in tests `node:sqlite`, never the system `sqlite3`.
Cursors are opaque strings, and a cursor is only valid for the source that issued it (helper or read-only fallback).
Helper cursors encode the keyset (match group, pin key, order timestamp, id), and read-only fallback cursors encode an offset into the same order, in the format that fallback has always issued.
Deep offset paging is the fallback's structural gap: a page deep in the list still walks every row before it, where a helper keyset cursor seeks straight to its page.

```ts
interface WindowData {
  current: Note | null;              // null only when no live notes exist
  previousNoteId: NoteId | null;     // newer neighbor in updatedAt desc order
  nextNoteId: NoteId | null;         // older neighbor in updatedAt desc order
  pinnedShortcutNoteIds: NoteId[];   // pin order, at most 9 (⌘1 through ⌘9); ⌘0 is reset zoom
}
```

```ts
type BackupReason = "manual" | "daily" | "pre-migration" | "pre-update" | "pre-restore";

interface BackupInfo {
  path: string; name: string;          // notes-<UTC timestamp>-v<version>-<reason>.sqlite
  createdAt: Millis; version: string;  // from the name; version is the helper that wrote it
  reason: BackupReason; sizeBytes: number;
}

interface SystemStatus {
  version: string; pid: number;
  schemaVersion: number;               // PRAGMA user_version of the open database
  noteCount: number;                   // live notes
  backupDir: string; backupCount: number; latestBackup: BackupInfo | null;
  restoreAvailable: boolean;           // see section 9
}
```

Purge rule: on startup, and every 24 h while running, notes with `deletedAt` strictly older than now minus 60 days are removed permanently.

**Editor-owned behavior (no helper state):**
- Zoom is applied by the editor in CSS; `window.resize.contentHeight` is in points (CSS px times zoom), measured from the content wrapper (never `documentElement.scrollHeight`).
- While a confirmation dialog is open the editor reports a larger `contentHeight` (about 34rem) and restores it on close; the helper treats every `window.resize` as programmatic (never as a user resize).
- Panels (⌘K, browse, settings) and dropdowns (the slash menu, the emoji picker, the link popover, and the format bar's menus) never resize the panel and never draw past it.
  The panels drop from the toolbar and their lists scroll when the panel is short.
  Each dropdown opens next to its anchor on its preferred side when it fits there, else on the side with more room, capped to that room so it scrolls inside, and slides sideways to stay inside.
  All of them keep clear of the drag strip and of the 10 pt resize zones.
- The helper provides a standard Edit menu (⌘C, ⌘X, ⌘V, ⌘Z, ⇧⌘Z, ⌘A) and maps ⇧⌘V to a real paste event in the web view; the editor turns that paste into plain text and never reads the clipboard itself.
- The panel is borderless: the editor draws its own Close control (`window.hide`) and the hover-only chrome. ⌘W hides the panel (helper menu item, like closing a window in any app).
- The helper gives the borderless panel generous resize hit zones: 10 pt along edges and 24 pt squares at corners, with the matching resize cursors.
  The top 10 pt of the drag strip is a resize zone.
  Keep interactive controls at least 24 pt from the panel corners.
- The panel is resizable (`.resizable`) and reports the standard window subrole (`AXStandardWindow`) to Accessibility, not the system dialog subrole a non activating panel gets by default, so system tiling and window managers can place and size it like an app window.
  Drags in the drag regions and the drag strip hand off to the window server (`performDrag`), the system's own window move.
  A frame the helper did not set itself (system tiling, a window manager through Accessibility, the system's own sliver of edge resize) is kept as the person's resize: it is stored like a drag in the resize zones, and a new height turns windowAutoSize off.
  Such a frame smaller than the minimum size grows to it first, keeping its top left corner; a frame at least the minimum stays exactly where it was put.
  Limits: the helper never activates, so it has no menu bar of its own (no Window > Move & Resize) and is never the frontmost app, and a borderless panel has no green button; window managers that only act on the frontmost app's focused window cannot reach it.
- `window.place` geometry, in whole points: `fill` is the display's visible frame; `left` and `right` split its width so the halves meet exactly, the left half taking the extra point of an odd width, at the full visible height; `center` keeps the current size, clamped to the minimum size and the visible frame, and centers it.
  A half narrower than the minimum size grows to it from its own screen edge.
  `left`, `right`, and `fill` end any temporary growth and turn windowAutoSize off, since they set the height; `center` changes no size and never touches windowAutoSize.
  The helper stores the placement, with the placed frame, in that display's point in `panelFrame.displays`, and runs it again against the display's current visible frame whenever the panel opens there.
  A display whose resolution changed has a new key, so a placement stored under another key with the same display uuid runs there too.
  A user resize, a drag move, a frame set from outside (tiling, a window manager), turning windowAutoSize on, another placement, or `settings.reset` clears the stored placement for that display and keeps the resulting frame.
  The editor offers Fill Left, Fill Right, Fill Screen, and Centre in the command panel's window section, with ⌃⌥←, ⌃⌥→, ⌃⌥↑, and ⌃⌥↓, and the menu bar's Window section shows the panel first and then places it.
- Temporary growth only grows: if the panel is already at least the requested height, nothing changes (so a dialog never resizes a roomy window).
- The editor owns the body tint (a darker, less transparent background for contrast); the helper keeps the vibrancy material underneath.
- One minimum size covers every way the panel's size is set: user resizing, auto-sizing, temporary growth, restored frames (a smaller saved frame grows to it), frames set from outside (tiling, window managers), and zoom.
  It is the editor's `window.setMinimumSize` report (the bars plus one line of the note at the current zoom), never below 405 by 197 pt, a floor that shows the toolbar and the first line or two at 100%.
  At 100% the floor applies; the report passes its width at about 120% zoom (just above 100% with the format bar) and its height at about 140%, and at 200% it is about 669 by 278 pt (747 pt wide with the format bar).
  Until the editor's first report the floor applies.
- The editor measures height directly in its ResizeObserver callback (not in requestAnimationFrame, which hidden WebKit windows pause), so the prewarmed panel is sized before it shows; a one-line note reports about 143 pt, so with auto-sizing on it rests at the 197 pt minimum with the footer at the bottom.
- With windowAutoSize on and no normal `window.resize` report yet (a cold start, for example `--show`), a show waits with the panel hidden for that first report, up to 3 s (a cold WebKit start on a slow machine takes about 1.5 s), and then orders the panel in at the reported height, so it never flashes the default height.
  A temporary report does not end the wait.
  While it waits, `window.toggle` cancels the show (result `visible: false`), `window.hide` cancels it too, `window.show { noteId }` still emits `note.open`, and turning windowAutoSize off shows the panel at once.
- Helper test-only flags: `--test-hooks` enables `test.*` socket methods.
- The helper overlays an invisible 12 pt drag strip along the panel's top edge; the editor keeps about 12 pt of non-interactive top padding.
- Back/forward history is two in-memory stacks in the editor (cap 100).
  Switching notes pushes the old current note on the back stack (skipping duplicates of the top) and clears forward.
  When a stack is empty, back goes to `previousNoteId` and forward to `nextNoteId`.
  Deleted ids are removed from both stacks.
- Every switch calls `notes.touchAccessed` and `notes.setCurrentNote` after flushing pending edits (a failed flush cancels the switch).
  A note the editor creates (⌘N, or the first note when none exist) or duplicates (⌘D) is persisted with `notes.setCurrentNote` too, since `notes.create` without `show` and `notes.duplicate` leave the current note alone.
- ⌘N on a note whose text is blank only shows a "You already have an empty note" notice.
- When `current` is null the editor creates a note immediately from the empty document.
- Deleting the current note opens `nextNoteId`, else `previousNoteId`, else creates a fresh empty note.
  Delete All leaves one fresh empty note and clears history.
- Content autosave and caret save are debounced 300 ms and flushed on switch, hide, and blur.
- Every content save sends `expectedUpdatedAt`, the `updatedAt` of the version the editor last loaded or saved.
- Outside changes are merged, never overwritten.
  On `notes.changed` the editor reloads the stored note when it is newer (a later `updatedAt`) than the version the editor last synced with, it has no unsaved edits, and the person is not typing (within 1 s of an edit).
  A stored note that is not newer, such as a reply that raced a save, is never loaded over the editor.
  Otherwise it merges the stored version into what it shows with `mergeDocs` (base: the version it last synced with), in place, keeping the caret and scroll, and saves the merge if it differs from the stored note.
  The merge adds no undo step: undo takes back only the person's own edits and never removes the outside change.
  A save that gets `conflict` (a socket write the editor was not told about, or one that raced the save) merges the same way and retries against the returned note, up to 3 attempts; after that the edits stay unsaved, the editor shows one "Could not save note" error (not one per attempt), and the next save tries again.
  When both sides changed the same block differently, the merge keeps both versions and the editor shows "This note also changed elsewhere, so both versions were kept", at most once per save, however many attempts kept both versions.
  When one side deleted a block the other changed, the change is kept and no notice shows, since only one version exists.
  While an input method composition is in progress, every merge waits until it ends, because replacing the document mid composition would break the text being composed.
  The wait is capped at 5 s, so a lost `compositionend` cannot hold saves, note switches, and hides forever: after that the merge is skipped and the edits stay unsaved (a save reports the failure), and the next save merges and tries again.

## 6. Database schema (owned by the helper)

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
-- PRAGMA user_version tracks migrations; version 1 is the notes and settings tables with the
-- two order indexes below, and version 2 adds the virtual generated sort columns, the paging
-- indexes over them, the FTS5 trigram table over the folded copies, and the triggers that keep
-- that table in sync with notes.
-- Where FTS5 or the trigram tokenizer is unavailable (probed outside the migration transaction),
-- version 2 still applies without the FTS5 table and its triggers.

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
  caret_position   INTEGER,
  -- version 2, added with ALTER TABLE ADD COLUMN:
  sort_pin_group    INTEGER GENERATED ALWAYS AS (pinned IS NULL) VIRTUAL,
  sort_pin_key      REAL GENERATED ALWAYS AS (COALESCE(pinned, 0.0)) VIRTUAL,
  sort_updated_neg  INTEGER GENERATED ALWAYS AS (-updated_at) VIRTUAL,
  sort_accessed_neg INTEGER GENERATED ALWAYS AS (-COALESCE(last_accessed_at, -1)) VIRTUAL
) STRICT, WITHOUT ROWID;

CREATE INDEX notes_list_order   ON notes (deleted_at, pinned, updated_at DESC, id);
CREATE INDEX notes_browse_order ON notes (deleted_at, pinned, last_accessed_at DESC, id);
-- version 2:
CREATE INDEX notes_list_page    ON notes (deleted_at, sort_pin_group, sort_pin_key, sort_updated_neg, id);
CREATE INDEX notes_browse_page  ON notes (deleted_at, sort_pin_group, sort_pin_key, sort_accessed_neg, id);

CREATE VIRTUAL TABLE notes_fts USING fts5(id UNINDEXED, title_fold, text_fold, tokenize = 'trigram');
CREATE TRIGGER notes_fts_after_insert AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (id, title_fold, text_fold) VALUES (NEW.id, NEW.title_fold, NEW.text_fold);
END;
CREATE TRIGGER notes_fts_after_update AFTER UPDATE OF title_fold, text_fold ON notes BEGIN
  DELETE FROM notes_fts WHERE id = OLD.id;
  INSERT INTO notes_fts (id, title_fold, text_fold) VALUES (NEW.id, NEW.title_fold, NEW.text_fold);
END;
CREATE TRIGGER notes_fts_after_delete AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE id = OLD.id;
END;

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
```

The helper keeps a second SQLite connection open read-only for `notes.list`, `notes.browse`, `notes.listDeleted`, and `notes.count`, under its own lock, so those reads run while a write is in flight on the single writer connection and a long read never delays a save.
A restore closes that connection under its lock and reopens it on the restored database before any read can use it, and when the read-only connection cannot be opened, reads fall back to the writer connection.
No write ever goes through the second connection, and there is still exactly one writer.

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
export function duplicateContent(note: { rawContent: string; text: string }, titleSuffix: string): NoteContent; // the copy's content with titleSuffix in the title's line (section 5)
export function mergeDocs(base: JSONContent, local: JSONContent, remote: JSONContent): { doc: JSONContent; conflicted: boolean; matchesRemote: boolean };
// three-way merge by top-level block (one list item is one block): changes to different blocks all apply; where both sides
// changed the same blocks into different non-empty versions, local's version comes first and remote's right after it
// (conflicted: true); an edit beats a delete (conflicted stays false); matchesRemote: the result is exactly remote
export function loadDoc(rawContent: string | null, text: string): JSONContent; // stored doc if valid (placeholders preserved), else rebuild from text with a hard break per newline
export function toStoredDoc(doc: JSONContent): JSONContent;               // inverse of loadDoc's placeholder mapping
export function docToClipboard(docOrSlice: JSONContent): { text: string; html: string };   // ⌘C/⌘X format: plain text plus semantic HTML
export function parsePastedText(plain: string, html?: string): JSONContent;
export function looksLikeMarkdown(plain: string, html?: string): boolean;
export function normalizeLinkHref(input: string): string | null;   // null for javascript:, data:, vbscript:, and file: (kept as text)
export function countCharacters(text: string): number;                   // grapheme clusters of trimmed text
export function countWords(text: string): number;                        // Intl.Segmenter word segments
export type { Note, NoteSummary, NoteContent, Settings, WindowData, NoteId } from "./types";
export * as rpc from "./rpc";
// Light entry point `@overnote/core/text` exports types, rpc, displayTitle, countCharacters, countWords, fold, highlightMarkdownMatches and UNTITLED, with no Tiptap import (for list commands and the menu bar)
```

## 8. Extension commands (package.json)

| name | title | mode | notes |
|---|---|---|---|
| `open-notes` | Open Overnote | no-view | Launch the helper with `--show` if needed, else `window.show` (never hides) |
| `toggle-notes` | Toggle Overnote | no-view | Launch the helper if needed, then `window.toggle` |
| `create-note` | Create Note | no-view | Optional `text` argument, then `fallbackText`, then selected text, then empty. `notes.create` with `show: true` |
| `search-notes` | Search Notes | view | List with markdown detail using `notes.list` with `filter` (or the read-only DB with the same order and matching); title matches are moved first within each page; writes through the helper |
| `recently-deleted` | Recently Deleted Notes | view | Recover, delete permanently, empty trash |
| `menu-bar` | Overnote Menu Bar | menu-bar | `interval: "1m"`, `disabledByDefault: true`; pinned and recent notes, new note, the Window placements (`window.show`, then `window.place`), the backup actions, and the restore offer; restarts a dead helper |
| `check-for-updates` | Check for Updates | no-view | Reads the version from `assets/prebuilt.json` (the helper's version in a source checkout), asks `https://api.github.com/repos/WesleyBLDC/overnote/releases/latest` with a 5 s timeout, compares semver, and shows a HUD. When newer, copies `cd '<installDir>' && npm run update-extension` to the clipboard; it never runs it. Not part of the Store copy |

Search Notes and the menu bar both offer **Back Up Notes Now**, **Restore Notes from Backup** (a list of backups, restored after a `confirmAlert`), and **Reveal Backups Folder**.
While `system.status` reports `restoreAvailable`, Search Notes shows **Restore Notes from Backup** as its first item (with a Dismiss action), and the menu bar shows it at the top.
Search Notes asks a running helper, and starts one only when the database does not exist yet, so lists stay instant.
The menu bar's restore item opens Search Notes with `launchContext: { restore: true }`, which shows the backup list directly.

No default hotkeys.

Launch context: `toggle-notes` accepts `launchContext: { id?: NoteId }` (shows that note via `window.show`), and `create-note` accepts `launchContext: { text?: string }`.
This lets deeplinks and quicklinks open a specific note or create one with text.

## 9. Backups, installs, and updates

The database stays in the extension's support directory (`environment.supportPath`), as Raycast recommends.
That folder is keyed by the extension name `overnote`, so it persists across `ray develop` reinstalls and updates; the name must never change.
Removing the extension can remove that folder, so backups live outside it.

**Backups.**
- Written by the helper with SQLite's online backup API (`sqlite3_backup_*`), so a copy is consistent while the database is in WAL mode, then switched to rollback journal mode so each backup is one self contained file.
- Folder `~/Library/Application Support/Overnote/backups` (or `OVERNOTE_BACKUP_DIR`), mode 0700; files mode 0600, written to a hidden `.partial` file and renamed into place.
- Name `notes-<UTC timestamp>-v<helper version>-<reason>.sqlite`, with the timestamp in ISO 8601 basic format with milliseconds (`20261015T093000.123Z`), so names sort by time.
- Reasons: `manual` (`system.backup`), `daily`, `pre-migration`, `pre-update` (`scripts/update-extension.sh`), and `pre-restore`.
- `daily`: half a second after startup and then every hour, the helper writes one when the newest backup of any reason is at least 24 h old.
  `daily` and `pre-migration` skip a database with no notes (live or trashed); the other reasons always write.
- `pre-migration`: before applying any migration to a database that has notes; if that backup fails, the helper does not migrate and does not start.
- Retention, after every backup: keep the newest 10, plus the newest backup of each of the last 4 ISO weeks in UTC (the current week and the 3 before it); delete the rest, and partial files older than an hour.
  A restore holds off pruning until it is done, so its `pre-restore` backup never removes the backup being restored.

**Restore offer.**
When the helper starts and `notes.sqlite` does not exist while the backups folder holds at least one backup (typically after the extension was removed and installed again), it creates an empty database, overwrites nothing, and stores the settings row `restoreOffer = "1"`.
`system.status.restoreAvailable` is true while that row is set and backups exist.
`system.restoreBackup` and `system.dismissRestoreOffer` clear it; the settings row is not part of `Settings`.

**Release metadata.**
`scripts/package-release.sh` records `version` (the tag) and `schemaVersion` (`OvernoteHelper --schema-version`) in `assets/prebuilt.json`.
Releases without `schemaVersion` wrote schema 1.
On tag builds, `scripts/check-version.sh` checks that the tag is semver and that the tag, `helper/VERSION`, `HelperVersion.current`, and the zip's `prebuilt.json` agree.
`scripts/prepare-store.sh` writes the same file into the Raycast Store copy, with `"channel": "store"`.

**Updates.** `npm run update-extension` (`scripts/update-extension.sh`) runs in an installed release folder:
1. Reads the installed version from `assets/prebuilt.json` (it refuses a folder without one, or a git checkout).
2. Resolves the target from `<api>/latest`, or `<api>/tags/vX.Y.Z` with `--version vX.Y.Z`, where `<api>` is `OVERNOTE_RELEASES_API` or `https://api.github.com/repos/WesleyBLDC/overnote/releases`; downloads `overnote-<version>.zip` and `SHA256SUMS` to a temporary folder and checks the zip.
3. Rollback guard: refuses a target whose `schemaVersion` is lower than the database's `PRAGMA user_version`, read with `sqlite3 -readonly` from a copy, before changing anything.
4. Backs up with `system.backup { reason: "pre-update" }`, starting the installed helper headless first when none answers; if the helper cannot start, it copies the database with `sqlite3 .backup` into the same folder under the same naming.
5. Stops the helper with `system.shutdown`, then SIGTERM to the pid in the pid file.
6. Replaces the folder's files with `rsync --checksum --delete`, excluding `node_modules`, and never touches the support folder or the backups folder (it refuses to run if either is inside the install folder); a changed lockfile forces `npm ci`.
   `assets/prebuilt.json` is copied last, so an interrupted update still reads as the old version and running it again finishes it.
   It then stops any helper Raycast started meanwhile, so the next command starts the new one.
7. Runs the new `scripts/install-extension.sh` and prints the old and new versions.

Only HTTPS is allowed for the API and the downloads (redirects included), unless `OVERNOTE_RELEASES_API` points at a test server.

The support, runtime, and backups folders default to the real ones and can be overridden with `OVERNOTE_SUPPORT_DIR`, `OVERNOTE_RUNTIME_DIR`, and `OVERNOTE_BACKUP_DIR`, which `scripts/e2e-update.sh` points at temporary folders.
The extension honors `OVERNOTE_RUNTIME_DIR` too (`src/domain/paths.ts`), which the command end-to-end tests (`src/__tests__/commands.e2e.test.ts`) use so they can never reach a helper someone is running.

## Protocol versioning

The protocol described here is v3.3 (v3.3 added `window.place` on the socket and the bridge with the `PanelPlacement` type, and optional `width`, `height`, and `placement` on each `panelFrame.displays` point, which older points simply lack; v3.2 raised the database to schema version 2 with an FTS5 trigram index over the folded title and text, virtual generated sort columns with paging indexes over them, and a shared TypeScript and Swift golden fold corpus, keeps the folded `LIKE` path for terms under three scalars and wherever the index is unavailable, and serves list, browse, deleted list, and count queries from a read-only second connection while every write stays on the single writer connection, with no change to any method shape, to list and browse ordering, or to cursor validity; v3.1 added the bridge-only `window.setMinimumSize` and removed the bridge-only `window.setOverhang`, since panels and dropdowns now stay inside the panel; bridge-only methods are refused on the socket, so no socket client is affected; v3.0 replaced `notes.duplicate`'s `titleSuffix`, which renamed only the stored title, with optional content built by the new core `duplicateContent`, and refuses `titleSuffix`; v2.15 made `notes.create` persist the current note only with `show: true` and `notes.duplicate` never, so socket writes no longer move the note the panel opens on, and made `mergeDocs` report an edit against a delete as not conflicted; v2.14 added `mergeDocs` to the core API, and the editor merges outside changes into unsaved edits instead of overwriting them; v2.13 added `window.setOverhang` and removed the unused `window.didBecomeKey` event; v2.12 added `settings.reset` and removed `derivePreview` from the core API; v2.11 added `--watch-editor`, the `editor.willReload` event, `assets/dev.json`, and the launch record; v2.10 added the `file.saveAs` timeout and `rpc.SAVE_AS_TIMEOUT_MS`; v2.9 added the backup methods, `--schema-version`, and the release metadata in section 9).
Any change to the wire shape (a method, its params or result, an event, a data type, the database schema, or the core API) bumps the version: a minor bump for additive or compatible changes, a major bump when existing callers would break.
The protocol version is not sent on the wire.
Instead the helper reports its release version (`helper/VERSION`) through `system.ping`, and the extension's launcher restarts a running helper whose version differs from the bundled binary, so the extension, helper, and editor of one release always speak the same protocol.
Helper 0.4.0 is the first release that speaks v2.14 and v2.15, so a socket client can tell from `system.ping` (or `system.status`) `version` whether the editor merges outside changes and whether a create or duplicate leaves the current note alone.
Helper 0.5.0 is the first release that speaks v3.0: `notes.duplicate` takes the copy's content and refuses `titleSuffix`, so a socket client that sent `titleSuffix` to 0.4.0 or earlier sends the content built with `duplicateContent` instead.
Bump the version at the top of this document in the same pull request as the code change, and name the new version in the pull request description.
