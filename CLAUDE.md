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

## Lead sessions

A lead session reads `lead.toml` and the rules it names; workers can ignore it.
