---
name: ship-feature
description: Take an Overnote change from a branch to a merged pull request with its docs updated. Use when a feature or fix is ready to land, when merging a PR, or when a branch has fallen behind main.
---

# Ship a feature

1. Catch up: `git fetch origin && git merge origin/main` on the branch.
   Never rebase a pushed branch, because the repo rules forbid rewriting pushed history.
   Resolve conflicts in tables (like the CONTRIBUTING layout table) by keeping both sides' facts and dropping anything a merged PR removed.
2. Docs in the same change, pruning what is stale (see "Keeping docs and rules current" in `AGENTS.md`):
   - `README.md` when behaviour, shortcuts, install, or what the README shows changes.
   - `CONTRIBUTING.md` layout table for new or removed files and scripts.
   - `docs/architecture.md` for any protocol, path, flag, schema, or bundle change, with a protocol version bump for protocol changes.
   - `docs/architecture/system-design.md` for new parts, flows, or hosts.
3. `npm run verify` must print `all steps passed`. Treat flaky or failing tests as defects.
4. Commit as `WesleyBLDC <WesleyBLDC@users.noreply.github.com>`, with no co-author trailer.
5. Publish the branch, then open the PR in a separate command: `gh-axi pr create -R WesleyBLDC/overnote --title "Area: summary" --body-file <file> --head <branch>`.
   Doing both in one command, or passing a base flag, trips the lead guard.
   The guard also matches words in heredoc text, so write file contents with the editor tools rather than shell heredocs when they mention branch rules.
6. Merge: `gh-axi pr merge <n> -R WesleyBLDC/overnote --squash --delete-branch`.
   "Base branch was modified" means another PR just merged; wait a few seconds and run it again.
   When several PRs are ready, merge them in dependency order, and merge `origin/main` into each later branch and verify again before merging it.
7. Record any lesson from this run as a rule or skill step (see "Learning" in `AGENTS.md`).
