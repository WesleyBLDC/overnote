# Overnote: agent instructions

Read `README.md`, `CONTRIBUTING.md`, `docs/architecture.md`, and `docs/clean-room.md` before working here.

## Clean room

- Build from `docs/architecture.md`, the existing code and tests, the public docs in this repository, and public library documentation.
- Never read the Raycast app bundle or any reverse-engineering output.

## Testing policy

- Keep unit tests to a minimum: only essential ones.
  - Serialization is covered by the fixture runner over `packages/core/tests/fixtures/`.
  - The rest is limited to logic end-to-end tests cannot reach cheaply, such as fold rules, ordering and cursor math, trash purge, and the launcher's restart and version logic.
  - Do not add a unit test for every function, and delete redundant ones when you touch an area.
- Every feature ends with end-to-end tests that exercise it the way a user does:
  - editor behavior through Playwright against the real editor UI in the browser harness;
  - helper and extension behavior through the real helper binary over its socket (`scripts/smoke-helper.sh` style);
  - full flows inside real Raycast in dev mode (hotkey toggle, panel, typing, persistence across restarts).
- A feature is done only when its end-to-end test passes, not when its unit tests pass.
- Run `npm run verify` before calling work done; it runs the whole suite in the same order as CI.

## Conventions

- Protocol changes go through `docs/architecture.md` in the same change as the code, with a protocol version bump.
- No dashes as punctuation in prose, and one sentence per line in Markdown docs.
