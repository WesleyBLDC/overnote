# Overnote: agent instructions

Read `PLAN.md`, `docs/contract.md`, and the private spec-team guide (clean-room rules) before working here.

## Clean room

- Build work reads only `PLAN.md`, `docs/`, `spec/`, `research/01` and `03` to `06`, and public docs.
- Never read the private spec-team notes, REA output, the Raycast app bundle, or scratch analysis files while building.
- In the real Raycast Notes, only ever use the note titled "(a dedicated test note)".

## Testing policy

- Keep unit tests to a minimum: only essential ones.
  - Serialization is covered by the fixture runner over `spec/fixtures/`.
  - The rest is limited to logic end-to-end tests cannot reach cheaply, such as fold rules, ordering and cursor math, trash purge, and the launcher's restart and version logic.
  - Do not add a unit test for every function, and delete redundant ones when you touch an area.
- Every feature ends with end-to-end tests that exercise it the way a user does:
  - editor behavior through Playwright against the real editor UI in the browser harness;
  - helper and extension behavior through the real helper binary over its socket (`scripts/smoke-helper.sh` style);
  - full flows inside real Raycast in dev mode (hotkey toggle, panel, typing, persistence across restarts).
- A feature is done only when its end-to-end test passes, not when its unit tests pass.

## Conventions

- Commits are local, authored as `WesleyBLDC <WesleyBLDC@users.noreply.github.com>`, with no co-author trailers.
  Do not push until asked.
- Contract changes go through `docs/contract.md` with a changelog entry.
- No dashes as punctuation in prose, and one sentence per line in Markdown docs.
