# Contributing to Overnote

Thanks for your interest in Overnote!
This guide covers how to set up the project, how it is organized, and the few rules that keep it healthy.

## Development setup

You need:

- macOS 14 Sonoma or later.
- [Raycast](https://www.raycast.com), installed and signed in.
- [Node.js](https://nodejs.org) 22 or later.
- The Xcode Command Line Tools (`xcode-select --install`); full Xcode is not required.

Then:

```sh
git clone https://github.com/WesleyBLDC/overnote.git
cd overnote
npm install
npm run dev
```

`npm run dev` builds the editor and the Swift helper, then runs the extension in Raycast development mode, with every change live:

- Extension code (`src/`) reloads in Raycast on save.
- Editor code (`editor/`, `packages/core/`) rebuilds on save, and the open panel saves the note and reloads with the new build within about a second.
- Helper code (`helper/`) rebuilds when it changes, and the next Raycast command restarts the helper.

Bind a hotkey to **Toggle Overnote** in Raycast Settings to open the panel.
The panel works on your real notes, as in any install.
Stop with ⌃C: Raycast keeps the extension, still running this checkout's last build.
To go back to a release, run `npm run install-extension` in the release folder.

For editor work you often do not need Raycast at all:

```sh
npm run dev -w editor
```

This serves the editor in your browser with an in-memory mock of the helper (`editor/src/dev/mockBridge.ts`).
Add `?seed=empty` to the URL to start with no notes.

## Project layout

| Path | What lives there |
|---|---|
| `package.json` | The Raycast manifest and the root scripts |
| `src/` | The Raycast extension: thin command files (`toggle-notes.ts`, `create-note.ts`, `search-notes.tsx`, `recently-deleted.tsx`, `menu-bar.tsx`) |
| `src/domain/` | Helper launcher, socket client, read-only database queries, and other logic with no Raycast imports |
| `src/api/`, `src/hooks/`, `src/components/` | Calls into the helper, React hooks, and shared list and detail views |
| `packages/core/` | `@overnote/core`: the ProseMirror schema, Markdown, HTML, and text serializers, and title rules, shared by the editor and the extension |
| `editor/` | The Vite, React, and Tiptap editor that runs inside the panel; builds to `assets/editor/` |
| `helper/` | `OvernoteHelper`, a Swift package: the floating panel, the web view, the socket server, and the SQLite repository |
| `packages/core/tests/fixtures/` | Serialization fixtures: input Markdown and the exact expected outputs |
| `scripts/` | Helper build, the full local suite (`verify.sh`), helper, window, and update end-to-end, the install and update scripts, release packaging and version checks, and the Raycast Store copy (`prepare-store.sh`) |
| `docs/` | Architecture and protocol reference, install and release guides, and the clean-room process |
| `assets/` | The icon, plus the built editor and helper (generated, not committed) |
| `media/` | README screenshots |

## The clean-room rule

Overnote reproduces the behavior of Raycast Notes without copying its code, so contributions must be clean-room.
The short version:

- Build only from [`docs/architecture.md`](docs/architecture.md), the existing code and tests, the public docs in this repository, and public library documentation (Tiptap, ProseMirror, AppKit, the Raycast extension API).
- Never decompile, disassemble, or read the Raycast app bundle, and never decrypt or read Raycast's databases or keys.
- Never use the Raycast name, icon, colors, or branding in the product.
- If you are unsure how something should behave, open an issue so the intended behavior can be settled, rather than guessing from Raycast's internals.

Please read [`docs/clean-room.md`](docs/clean-room.md) before your first pull request.

## Testing policy

Overnote has few unit tests and many end-to-end tests.

- Keep unit tests to the essentials.
  Serialization is covered by the fixture runner over `packages/core/tests/fixtures/`.
  Beyond that, unit tests are only for logic end-to-end tests cannot reach cheaply, such as fold rules, ordering and cursor math, trash purge, and the launcher's restart and version logic.
  Do not add a unit test for every function, and remove redundant ones when you touch an area.
- Every feature closes with end-to-end tests that exercise it the way a person does:
  - editor behavior through Playwright against the real editor UI in the browser harness (`editor/tests/`);
  - helper and extension behavior through the real helper binary over its socket (`scripts/smoke-helper.sh` style);
  - full flows inside real Raycast in development mode (hotkey toggle, panel, typing, persistence across restarts).
- A feature is done when its end-to-end test passes, not when its unit tests pass.

Run the whole suite, in the same order as CI, with one command:

```sh
npx playwright install webkit chromium   # once
npm run verify
```

`npm run verify` typechecks, lints, builds the editor and the helper, runs every unit and end-to-end suite, builds the extension, and assembles the Store copy, stopping at the first failing step.
Playwright needs both WebKit (the engine of the native panel, which runs every editor flow) and Chromium (a second engine check of the shipped bundle).
The panel window check (`scripts/e2e-window.sh`) shows the panel on screen and needs a logged in GUI session, so `npm run verify` skips it on a workstation and runs it in CI.
Set `OVERNOTE_WINDOW_E2E=1` to run it locally, or `OVERNOTE_WINDOW_E2E=0` to skip it even in CI.

To run one suite at a time:

```sh
npm run lint                     # ray lint: manifest, ESLint, and Prettier for the extension
npx eslint editor packages/core  # editor and core lint
npm run typecheck
npm test                         # extension unit tests and helper socket tests
npm test -w packages/core        # serialization fixtures and core essentials
npm test -w editor               # editor unit tests
npm run test:e2e -w editor       # editor end-to-end (WebKit, plus a Chromium build check)
bash helper/test.sh              # helper unit tests
bash scripts/smoke-helper.sh     # helper end-to-end over its socket
bash scripts/e2e-window.sh       # panel window behavior end-to-end
bash scripts/e2e-update.sh       # install, update, backups, and restore end-to-end (headless)
```

Every suite that starts the helper points `OVERNOTE_BACKUP_DIR` at a temporary folder, so tests never write into your real backups.
Keep it that way when you add one.

Flaky tests count as failures.
If you see one, even outside your change, please fix it or open an issue.

## Style

- Formatting and linting follow `npm run lint` (`ray lint`: Raycast's manifest checks, ESLint, and Prettier) for the extension in `src/`.
- The editor and `@overnote/core` use the same Prettier config and the root `eslint.config.js`, with typescript-eslint and the React hooks rules: `npx eslint editor packages/core` and `npx prettier --check editor packages/core`.
- Markdown files are not formatted by Prettier (`.prettierignore`), and the serialization fixtures are never reformatted.
- In Markdown docs, put each sentence on its own line, and do not use dashes as punctuation (hyphens in compound words are fine).

## Commit conventions

- Keep the subject short, in the imperative, and in sentence case, for example `Add find and replace to the editor`.
- Prefix the area when it helps: `Helper: …`, `Editor: …`, `Protocol: …`.
- Explain the why in the body when it is not obvious from the diff.
- Keep commits focused: one logical change each, with its tests.
- Never edit generated files by hand (for example the editor build in `assets/editor/` or `raycast-env.d.ts`).

## Proposing protocol changes

[`docs/architecture.md`](docs/architecture.md) is the single source of truth for how the extension, the helper, the editor, and `@overnote/core` talk to each other.

1. Open an issue that describes the change, why it is needed, and which components it touches.
2. Once agreed, update `docs/architecture.md` in the same pull request as the code, and bump its protocol version as its Protocol versioning section describes.
3. Update every caller and the mock bridge (`editor/src/dev/`) so both sides match, and cover the change with end-to-end tests.

If user-visible behavior changes, update `README.md` too, and describe the change in the pull request; the maintainer keeps `CHANGELOG.md`.

## Questions

Open an issue on [GitHub](https://github.com/WesleyBLDC/overnote/issues).
Thank you for helping out!
