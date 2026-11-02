# Overnote Changelog

## [0.5.0] - 2026-10-24

- Window placement: Fill Left, Fill Right, Fill Screen, and Centre from ⌘K, ⌃⌥ arrows, and the menu bar, remembered per display.
- System tiling and window managers can place the panel through Accessibility.
- Search: FTS5 trigram index (database schema 2), with a read-only second connection for lists and browse.
- Duplicate puts the title suffix in the copy's first line (`notes.duplicate` protocol v3.0).
- Editor polish: iris violet accent, hit targets and focus ring, loading and error states, nested ordered numbering, dropdowns kept inside the panel.
- Release builds ship an arm64 helper by default; `helper/VERSION` is the single source of truth.
- Local `npm run verify` is the gate; the GitHub Actions CI workflow was removed.

## [0.3.0] - 2026-10-15

- Hardened install and update flow with checksum checks and pre-update backups.
- Restore from backup and rollback guards for database schema.
- Store-oriented packaging and prebuilt release zips.

## [0.1.0] - 2026-10-15

- First public GitHub release of the Raycast extension and helper.

## [Initial Release] - {PR_MERGE_DATE}

- A floating markdown notepad, toggled with any hotkey you bind to Toggle Overnote.
- The panel floats over full-screen apps and on every Space, and takes typing without stealing focus from the app you are in.
- Markdown shortcuts as you type, a slash menu, an emoji picker, and a format bar.
- Task lists with ⌘↩ to check items, including nested tasks.
- Code blocks with syntax highlighting.
- Find and replace inside a note.
- Pinned notes with ⇧⌘P, opened with ⌘1 to ⌘9.
- Back and forward history with ⌘[ and ⌘].
- Browse Notes (⌘P) with search across titles and text.
- Recently Deleted, with restore for 60 days.
- Copy and export as Markdown, HTML, or plain text.
- Zoom from 75% to 200%, window auto-sizing, and a character or word count.
- Search Notes, Create Note, and Recently Deleted Notes commands.
- An optional menu bar command with pinned and recent notes.
- Deeplinks and quicklinks that open a specific note.
- All notes are stored locally in SQLite, with no network access.
