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

`npm run dev` builds the editor and the Swift helper, then runs the extension in Raycast development mode with live reload.
Bind a hotkey to **Toggle Overnote** in Raycast Settings to open the panel.

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
| `scripts/` | Helper build, helper end-to-end, and window end-to-end scripts |
| `spec/` | Behavioral specs and serialization fixtures |
| `docs/` | The component contract and the clean-room process |
| `assets/` | The icon, plus the built editor and helper (generated, not committed) |
| `media/` | README screenshots |

## The clean-room rule

Overnote reproduces the behavior of Raycast Notes without copying its code, so contributions must be clean-room.
The short version:

- Build only from `PLAN.md`, `docs/`, `spec/`, the public research notes in `research/`, and public library documentation (Tiptap, ProseMirror, AppKit, the Raycast extension API).
- Never decompile, disassemble, or read the Raycast app bundle, and never decrypt or read Raycast's databases or keys.
- Never use the Raycast name, icon, colors, or branding in the product.
- If you are unsure how something should behave, open an issue so the spec can be clarified, rather than guessing from Raycast's internals.

Please read [`docs/clean-room.md`](docs/clean-room.md) before your first pull request.

## Testing policy

Overnote has few unit tests and many end-to-end tests.

- Keep unit tests to the essentials.
  Serialization is covered by the fixture runner over `spec/fixtures/`.
  Beyond that, unit tests are only for logic end-to-end tests cannot reach cheaply, such as fold rules, ordering and cursor math, trash purge, and the launcher's restart and version logic.
  Do not add a unit test for every function, and remove redundant ones when you touch an area.
- Every feature closes with end-to-end tests that exercise it the way a person does:
  - editor behavior through Playwright against the real editor UI in the browser harness (`editor/tests/`);
  - helper and extension behavior through the real helper binary over its socket (`scripts/smoke-helper.sh` style);
  - full flows inside real Raycast in development mode (hotkey toggle, panel, typing, persistence across restarts).
- A feature is done when its end-to-end test passes, not when its unit tests pass.

Run the suites:

```sh
npm run lint
npm run typecheck
npm test                         # extension unit tests and helper socket tests
npm test -w packages/core        # serialization fixtures and core essentials
npm test -w editor               # editor unit tests
npx playwright install webkit    # once
npm run test:e2e -w editor       # editor end-to-end in WebKit
bash helper/test.sh              # helper unit tests
bash scripts/smoke-helper.sh     # helper end-to-end over its socket
bash scripts/e2e-window.sh       # panel window behavior end-to-end
```

Flaky tests count as failures.
If you see one, even outside your change, please fix it or open an issue.

## Style

- Formatting and linting follow `npm run lint` (Raycast's ESLint and Prettier config).
- In Markdown docs, put each sentence on its own line, and do not use dashes as punctuation (hyphens in compound words are fine).

## Commit conventions

- Keep the subject short, in the imperative, and in sentence case, for example `Add find and replace to the editor`.
- Prefix the area when it helps: `Helper: …`, `Editor: …`, `Contract: …`.
- Explain the why in the body when it is not obvious from the diff.
- Keep commits focused: one logical change each, with its tests.
- Never edit generated files by hand (for example the editor build in `assets/editor/` or `raycast-env.d.ts`).

## Proposing contract changes

[`docs/contract.md`](docs/contract.md) is the single source of truth for how the extension, the helper, the editor, and `@overnote/core` talk to each other.

1. Open an issue that describes the change, why it is needed, and which components it touches.
2. Once agreed, update `docs/contract.md` in the same pull request as the code, and add an entry at the top of its Changelog section with the new version and date.
3. Update every caller and the mock bridge (`editor/src/dev/`) so both sides match, and cover the change with end-to-end tests.

If behavior itself changes (not just the wire shape), update the relevant file in `spec/` too.

## Questions

Open an issue on [GitHub](https://github.com/WesleyBLDC/overnote/issues).
Thank you for helping out!
