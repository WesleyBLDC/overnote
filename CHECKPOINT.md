# Checkpoint: local session tree (2026-11-01)

## Branches

| Branch | Role |
|---|---|
| `wip/local-session-tree-2026-11-01` | Working branch for this saved WIP |
| `checkpoint/local-session-tree-2026-11-01` | Frozen pointer at the same commit (do not rewrite) |

## What this is

A snapshot of the maintainer's dirty `main` checkout before it was aligned with `origin/main`.

- **Base commit:** `93631bd` (`Helper: version 0.4.0`, never released as a tag)
- **Behind at save time:** 38 commits on `origin/main` (through `v0.5.0` / `fcd6392` docs)
- **Nature:** Uncommitted port / parallel work that mostly landed upstream as PRs #2 to #13 (search schema 2, editor theme, window placement, verify:fast, arm64 helper, visual tests, perf harness, and related docs). Treat as **superseded archive**, not a merge candidate onto current `main`.

## What it contains (high level)

- Editor UI and styles (iris accent, panels, notices, icons)
- Window placement and panel geometry helper code
- Schema 2 / FTS / read-only DB paths (older protocol numbering than public v3.x)
- Visual Playwright specs and snapshots
- Perf harness scripts (result JSON files stay gitignored)
- Assorted docs and media edits mixed with the later docs commit on `main`

## How to use

```sh
git fetch origin
git switch wip/local-session-tree-2026-11-01
# or the frozen alias:
git switch checkpoint/local-session-tree-2026-11-01
```

Do not merge this branch into `main` without a deliberate cherry-pick plan.
Compare against current main with `git diff origin/main...checkpoint/local-session-tree-2026-11-01`.

## Related

Public release at save time: `v0.5.0` @ `e7fb445`, plus docs commit `fcd6392`.
Private plan notes: `overnote-private` learnings `2026-11-01-docs-release-audit.md`.
