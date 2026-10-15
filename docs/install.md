# Installing Overnote from a release

Overnote is not in the Raycast Store yet.
Each GitHub release carries a zip with everything prebuilt, so you install it without building anything.

You need macOS 14 Sonoma or later, [Raycast](https://www.raycast.com) installed and signed in, and [Node.js](https://nodejs.org) 22 or later.
You do not need Xcode or the Xcode Command Line Tools.

## Install

1. Download `overnote-<version>.zip` from the latest release on the [Releases page](https://github.com/WesleyBLDC/overnote/releases).
2. Unzip it and move the `overnote` folder somewhere stable, for example `~/Applications/Overnote`.
   Raycast runs the extension from this folder, and updates replace its files in place, so keep it there.
3. In Terminal, go into that folder and run the installer:

   ```sh
   cd ~/Applications/Overnote/overnote
   npm run install-extension
   ```

   It installs the dependencies, checks the prebuilt helper against its checksum, and registers the extension with Raycast.
   It takes about a minute, once.
4. Open Raycast Settings, go to Extensions, find **Toggle Overnote**, and record a hotkey for it (for example ⌥N).
5. Press your hotkey to open the panel.

macOS marks downloaded files with a quarantine attribute, and Gatekeeper refuses to start a quarantined helper that is not notarized.
You do not need to do anything about it: the installer and the extension's launcher check the helper against its `.sha256` checksum and only then clear the attribute.
A helper that does not match its checksum is never started.

To check a download yourself, compare `shasum -a 256 overnote-<version>.zip` with the line in the release's `SHA256SUMS`.

## Update

Run **Check for Updates** in Raycast to see whether a newer release exists.
If one does, it copies the update command to the clipboard; paste it into Terminal:

```sh
cd ~/Applications/Overnote/overnote
npm run update-extension
```

The update downloads the latest release and its `SHA256SUMS`, checks the zip, backs up your notes, stops Overnote, replaces the files in the folder (keeping `node_modules`), and runs the installer again.
It prints the old and new versions, and where the backup went.
Your notes are never in this folder, so an update cannot remove them.
If an update is interrupted, run `npm run update-extension` again to finish it.

To install a specific release, or to go back to an older one, name it:

```sh
npm run update-extension -- --version v0.3.0
```

A rollback is refused when your notes already use a newer database format than that release understands, because Overnote never downgrades a database.

## Back up and restore

Your notes live in one SQLite file, `notes.sqlite`, in the extension's Raycast support folder.
Backups are kept separately, in `~/Library/Application Support/Overnote/backups`, so they survive removing the extension.

- Overnote writes a backup once a day while it runs, and before every update, database upgrade, and restore.
- It keeps the latest 10 backups, plus the newest one from each of the last 4 weeks.
- Each backup is a complete, ordinary SQLite file named like `notes-20261015T093000.000Z-v0.3.0-daily.sqlite`: the time in UTC, the Overnote version, and why it was written.

In Search Notes (any note's action panel) and in the menu bar:

- **Back Up Notes Now** writes a backup right away.
- **Restore Notes from Backup** lists the backups, newest first.
  Restoring one replaces every note, after Overnote backs up the current notes, so a restore can itself be undone.
- **Reveal Backups Folder** opens the folder in Finder.

If you remove Overnote and install it again, it starts with no notes and never overwrites anything.
When it finds backups, Search Notes shows **Restore Notes from Backup** as the first item until you restore or dismiss it.

## Uninstall

1. Open Raycast Settings, go to Extensions, select Overnote, and remove it.
2. Delete the folder you installed from.

Your backups stay in `~/Library/Application Support/Overnote/backups`, and installing again offers to restore them.
To remove every trace, delete that folder too, along with the extension's support folder, `~/Library/Application Support/com.raycast.macos/extensions/overnote`, if Raycast left it behind.

## Troubleshooting

- **"Node.js 22 or later is required"**: install the current Node.js LTS from [nodejs.org](https://nodejs.org) and run the installer again.
- **"The prebuilt helper is missing or does not match"**: the download was damaged or changed; download the zip again.
- **Overnote does not show up in Raycast**: make sure Raycast is running and signed in, then run `npm run install-extension` again.
- **"This folder is not an installed release"**: `npm run update-extension` works only in a folder unzipped from a release; in a git checkout, use `git pull` and `npm run install-extension`.

The helper also ships on its own as `OvernoteHelper-<version>.zip` with `OvernoteHelper.sha256`, for people who build the extension from source without the Command Line Tools.
Put the unzipped `OvernoteHelper` and `OvernoteHelper.sha256` into `assets/bin/` of a checkout.
