# Overnote

A floating markdown notepad, one hotkey away.
Overnote is an open-source Raycast extension: press your hotkey and a small notes panel floats over whatever you are doing, ready for typing, without pulling focus away from the app underneath.
Press it again and it is gone.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="media/note-light.png" />
    <img src="media/note-dark.png" width="640" alt="The Overnote panel showing a note with a heading, a task list, and a highlighted code block" />
  </picture>
</p>

> Inspired by Raycast Notes; not affiliated with Raycast.

## Features

- **A floating panel that never steals focus.**
  It opens over full-screen apps and on every Space, takes your keystrokes, and leaves the app you were in active.
- **Markdown as you type.**
  Shortcuts like `#`, `-`, `1.`, `[ ]`, `>`, and fenced code turn into formatting on the spot, and a `/` slash menu inserts any block.
- **Task lists** with ⌘↩ to check and uncheck, including nested tasks.
- **Code blocks with syntax highlighting.**
- **Find and replace** inside a note with ⌘F.
- **Pins:** pin notes with ⇧⌘P and jump to the first nine with ⌘1 to ⌘9.
- **History:** go back and forward through the notes you opened with ⌘[ and ⌘].
- **Browse** every note with ⌘P, searching titles and text.
- **Recently Deleted:** deleted notes stay restorable for 60 days.
- **Export and copy** a note, or just the selection, as Markdown, HTML, or plain text.
- **Raycast commands:** Search Notes (with a rendered preview), Create Note (from an argument, the search bar, or selected text), and Recently Deleted Notes.
- **Menu bar command** with pinned and recent notes, one click away.
- **Deeplinks and quicklinks** that open a specific note from anywhere.

<p align="center">
  <img src="media/actions-dark.png" width="420" alt="The ⌘K action panel listing note actions with their shortcuts" />
  <img src="media/browse-dark.png" width="420" alt="Browse Notes listing pinned notes above the rest" />
</p>

## Install

Overnote is not in the Raycast Store yet.
You need macOS 14 Sonoma or later, [Raycast](https://www.raycast.com) installed and signed in, and [Node.js](https://nodejs.org) 22 or later.

### Download a release

This is the quickest way, with nothing to build.

1. Download `overnote-<version>.zip` from the latest release on the [GitHub Releases page](https://github.com/WesleyBLDC/overnote/releases), and unzip it.
2. In Terminal, go into the unzipped `overnote` folder and run `npm run install-extension`.
3. Open Raycast Settings, go to Extensions, find **Toggle Overnote**, and record a hotkey for it.
   Overnote ships with no default hotkey, so pick whatever feels natural (for example ⌥N).

[`docs/install.md`](docs/install.md) has the full steps, updating, checksums, and troubleshooting.

### Build from source

Building from source also needs the Xcode Command Line Tools (`xcode-select --install`); full Xcode is not needed.

```sh
git clone https://github.com/WesleyBLDC/overnote.git
cd overnote
npm install
npm run dev
```

`npm run dev` builds the editor and the native helper, then installs the extension into Raycast in development mode.
Once Raycast shows the Overnote commands you can stop it with ⌃C; the extension stays installed.
Then bind a hotkey to **Toggle Overnote** as in step 3 above.

## Usage

Press your hotkey to show the panel, type, and press it again (or ⎋) to hide it.
Everything saves automatically.
Press ⌘K at any time to see every action with its shortcut.

### Keyboard shortcuts

These work in the Overnote panel.
Press ⌘K in the panel for the full list of actions with their shortcuts.

| Shortcut | Action |
|---|---|
| ⌘K | Open or close the action panel |
| ⌘P | Browse notes |
| ⌘N | New note |
| ⌘D | Duplicate note |
| ⇧⌘P | Pin or unpin the note |
| ⌘1 to ⌘9 | Open pinned note 1 to 9 |
| ⌘[ / ⌘] | Go back / go forward (also ⌥⌘↓ / ⌥⌘↑) |
| ⌘F | Find; ⌥⌘↓ in the find field shows replace |
| ⇧⌘C | Copy note (or selection) as Markdown, HTML, or text |
| ⇧⌘E | Export as Markdown, HTML, or text |
| ⇧⌘D | Copy deeplink |
| ⌃X | Delete note (restorable for 60 days) |
| ⌃⇧X | Delete all notes, after a confirmation |
| ⌥⌘, | Show or hide the format bar |
| ⇧⌘, | Format menu |
| ⌃⌘↑ / ⌃⌘↓ | Move list item up / down |
| ⇧⌘/ | Toggle window auto-sizing |
| ⌘= / ⌘- / ⌘0 | Zoom in / zoom out / actual size (75% to 200%) |
| ⎋ or ⌘W | Hide the panel |

Formatting inside the editor:

| Shortcut | Action |
|---|---|
| ⌘B / ⌘I / ⌘U | Bold / italic / underline |
| ⇧⌘S | Strikethrough |
| ⌘E | Inline code |
| ⌘L | Add or edit a link |
| ⌥⌘1 / ⌥⌘2 / ⌥⌘3 | Heading 1 / 2 / 3 |
| ⌥⌘C | Code block |
| ⇧⌘B | Blockquote |
| ⇧⌘7 / ⇧⌘8 / ⇧⌘9 | Numbered / bulleted / task list |
| ⌘↩ | Check or uncheck a task; open a link; leave a code block |
| ⇧⌘↩ | Toggle a task together with its nested tasks |
| Tab / ⇧Tab | Indent / outdent a list item |
| ⇧⌘V | Paste as plain text |
| `/` | Slash menu |
| `:` | Emoji picker |

### Raycast commands

| Command | What it does |
|---|---|
| Toggle Overnote | Shows or hides the floating panel. Bind your hotkey here. |
| Create Note | Creates a note from its argument, the Raycast search text, or the selected text, and opens it. |
| Search Notes | Lists notes grouped by date, with a preview and actions to open, pin, copy, duplicate, and delete. |
| Recently Deleted Notes | Restores deleted notes or removes them for good. |
| Overnote Menu Bar | Pinned and recent notes in the menu bar. Off by default; enable it in Raycast Settings. |

Copy Deeplink (⇧⌘D in the panel, or from Search Notes) gives you a `raycast://` link that opens that exact note.
Create Quicklink in Search Notes saves it as a Raycast quicklink.

## How it works

A Raycast extension cannot draw its own windows, so Overnote ships a small native helper that owns the floating panel and the database.

```
Raycast
 └─ Overnote extension (TypeScript)
      Toggle · Create Note · Search Notes · Recently Deleted · Menu Bar
      │
      │  JSON-RPC over a Unix socket
      ▼
 OvernoteHelper (Swift, no Dock icon)
   ├─ floating NSPanel (non-activating, all Spaces, over full-screen apps)
   │    └─ WKWebView ── Tiptap editor (React, ProseMirror)
   │                     ⇅ message bridge, same methods as the socket
   └─ SQLite database (single writer, WAL)

 @overnote/core: schema and Markdown / HTML / text serializers,
                 shared by the editor and the extension
```

- The extension starts the helper on demand and talks to it over a Unix socket.
  Toggling a warm panel is near instant.
- The editor runs inside the panel's web view and calls the same note methods through a message bridge.
- Notes are stored as ProseMirror JSON, with Markdown and plain text derived on every save.

### Your data

- Notes live in a SQLite database, `notes.sqlite`, inside the extension's Raycast support directory (`environment.supportPath`), next to the helper's log.
- Everything stays on your Mac.
  Overnote makes no network requests, has no account, and sends no analytics; the editor even runs under a content security policy that blocks network connections.
- Deleted notes are purged automatically after 60 days.

## Development

```sh
npm install
npm run dev          # build the editor and helper, then run the extension in Raycast
```

| Script | Purpose |
|---|---|
| `npm run dev` | Build everything and start Raycast development mode |
| `npm run build` | Production build of the extension (`ray build`) |
| `npm run build:editor` | Build the editor into `assets/editor/` |
| `npm run build:helper` | Build the universal helper into `assets/bin/` |
| `npm run lint` / `npm run fix-lint` | Raycast lint (ESLint and Prettier) |
| `npm run typecheck` | TypeScript, no emit |
| `npm run verify` | The full local suite, in the same order as CI |
| `npm run dev -w editor` | Editor in a browser with a mock helper, for fast UI work |

### Tests

Overnote keeps unit tests to the essentials and closes every feature with end-to-end tests that use the product the way a person does.

| Suite | Command |
|---|---|
| Extension unit and helper socket tests | `npm test` |
| Serialization fixtures and core essentials | `npm test -w packages/core` |
| Editor unit tests | `npm test -w editor` |
| Editor end-to-end (Playwright in WebKit, plus a Chromium build check) | `npm run test:e2e -w editor` |
| Helper unit tests | `bash helper/test.sh` |
| Helper end-to-end over its real socket | `bash scripts/smoke-helper.sh` |
| Panel window behavior end-to-end | `bash scripts/e2e-window.sh` |

`npm run verify` runs all of them, plus typechecking, lint, and the builds, in the same order as CI.
Run `npx playwright install webkit chromium` once before the editor end-to-end suite.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

## Project status and roadmap

Overnote is early and pre-release.
Feature parity with Raycast Notes (minus AI and sync) is built, and the open-source launch with prebuilt releases is in progress.

Planned next:

- Our own features: unlimited notes, several notes open at once, tags or folders, ranked search, backlinks, image paste, and templates.
- A Raycast Store submission.
- Add-ons, such as a one-way Markdown mirror folder.

## Project docs

| File | Contents |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Architecture and protocol reference: paths, socket and bridge protocol, data types, methods, schema, core API |
| [`docs/install.md`](docs/install.md) | Installing from a release, updating, and troubleshooting |
| [`docs/releasing.md`](docs/releasing.md) | How releases are built and published |
| [`docs/clean-room.md`](docs/clean-room.md) | How the clean-room process works |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup, project layout, testing policy, and conventions |
| [`CHANGELOG.md`](CHANGELOG.md) | Release notes |

## License

[MIT](LICENSE) © 2026 WesleyBLDC.

## Acknowledgements

Overnote is inspired by Raycast Notes and follows its behavior and layout closely, built clean-room from written behavior specs (see [`docs/clean-room.md`](docs/clean-room.md)).
It is not affiliated with or endorsed by Raycast, and it uses its own name, icon, colors, and design.
