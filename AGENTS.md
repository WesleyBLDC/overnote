# Overnote: agent instructions

## Read first

- `README.md` and `CONTRIBUTING.md`: setup, project layout, testing, style, and commits.
- `docs/architecture/system-design.md`: the big picture (why a Raycast extension plus a native helper, the C4 views, the main data flows).
- `docs/architecture.md`: the protocol of record; read the section you touch for any method, type, path, schema, or core API detail.
- `docs/clean-room.md` before your first change.

## Rules

- Clean room: build only from this repository's docs, code, and tests plus public library documentation; never read the Raycast app bundle or any reverse-engineering output.
- Testing follows the Testing policy in `CONTRIBUTING.md`: keep unit tests to the essentials and delete redundant ones in areas you touch; a feature is done only when its end-to-end test passes; run `npm run verify` before calling work done.
- CI runs only `npm run verify:fast` on pull requests, so a green CI run never replaces `npm run verify`.
- Protocol changes update `docs/architecture.md` in the same change as the code, with a protocol version bump.
- `main` only moves through a merged pull request: work on a branch and open one; never push to `main` or force push.
- Prettier formats every file it supports; Claude Code's hook formats each edited file, and other agents run `npx prettier --write <files>`.
- Prose: no dashes as punctuation (hyphens in compound words are fine), and one sentence per line in Markdown.

## User docs in the same change

Ship user-visible changes with their docs:

- `README.md` Features, Usage, Install, or command tables, when behaviour, shortcuts, requirements, or install steps change.
- `docs/install.md`, when install, update, backup, or uninstall steps change.
- `docs/writing-notes.md`, when Markdown rendering or writing guidance changes.
- `media/*.png`, when chrome the README shows changes (accent, toolbar, ⌘K icons or rows, Browse badges, hero note, panel geometry): refresh with `npm run shots:readme` as `CONTRIBUTING.md` Screenshots describes, and never copy Playwright baselines into `media/`.
- `CHANGELOG.md` only when the maintainer asks.

Keep the README short; long guides belong under `docs/`.

## Lead sessions

A lead session reads `lead.toml` and the rules it names; workers can ignore it.
