# Overnote: agent instructions

Read `README.md`, `CONTRIBUTING.md`, `docs/architecture.md`, and `docs/clean-room.md` before working here.

## Clean room

- Build from `docs/architecture.md`, the existing code and tests, the public docs in this repository, and public library documentation.
- Never read the Raycast app bundle or any reverse-engineering output.

## Testing policy

Follow the Testing policy in `CONTRIBUTING.md`.

- Keep unit tests to the essentials, and delete redundant ones when you touch an area.
- A feature is done only when its end-to-end test passes.
- Run `npm run verify` before calling work done.

## Conventions

- Protocol changes go through `docs/architecture.md` in the same change as the code, with a protocol version bump.
- No dashes as punctuation in prose, and one sentence per line in Markdown docs.

## User docs and screenshots

When you ship a user-visible change, update the docs in the same change:

- **README Features, Usage, Install, or command tables** when behaviour, shortcuts, requirements, or install steps change.
- **`docs/install.md`** when install, update, backup, or uninstall steps change.
- **`docs/writing-notes.md`** when Markdown rendering or writing guidance changes.
- **`CHANGELOG.md`** only when the maintainer asks (Store format; maintainer owned).
- **`media/*.png`** when chrome that README shows changes: accent, toolbar, ⌘K icons or rows (including Fill Left / Right / Screen / Centre), Browse badges, hero note content, or panel geometry.

Refresh README shots with the in-repo harness script (Playwright WebKit, 2×, no new deps):

```sh
npm run dev -w editor -- --port 5299 --strictPort --host 127.0.0.1
npm run shots:readme
```

Do not paste Playwright visual baselines into `media/`.
Store screenshots in `metadata/` are separate (`tools/store-shots.mjs` in the private repo, or real Raycast Window Captures before Store submit).
Keep the README short; long guides belong under `docs/`.

## Lead sessions

A lead session reads `lead.toml` and the rules it names; workers can ignore it.
