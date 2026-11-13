# Installing Overnote from a release

Overnote is a Raycast extension: the floating panel is a helper process the extension starts.
Overnote is not in the Raycast Store yet.
Each GitHub release carries a zip with everything prebuilt, so you install it without building anything.
You can also build Overnote as a standalone menu bar app on your own Mac, from source (see [The local app](#the-local-app-overnoteapp)).
Both are named Overnote, and both open the same notes.

You need an Apple silicon Mac on macOS 14 Sonoma or later, [Raycast](https://www.raycast.com) installed and signed in, and [Node.js](https://nodejs.org) 22 or later.
Release zips ship an arm64 helper only.
Intel Macs need a source build with `OVERNOTE_HELPER_ARCHES="arm64 x86_64"` (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
You do not need Xcode or the Xcode Command Line Tools for a release install.

## Install

1. Download `overnote-<version>.zip` from the latest release on the [Releases page](https://github.com/WesleyBLDC/overnote/releases).
2. Unzip it and move the `overnote` folder to a stable path, renaming it if you like, for example to `~/Applications/Overnote`.
   That folder is the extension root (it contains `package.json`).
   Raycast runs the extension from here, and updates replace its files in place, so keep it there.
3. In Terminal, go into that folder and run the installer:

   ```sh
   cd ~/Applications/Overnote
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
cd ~/Applications/Overnote
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

## The local app (Overnote.app)

`Overnote.app` runs the same panel and editor as the extension, without Raycast: it lives in the menu bar, has no Dock icon, and opens the panel with its own hotkey, ⌃⌥N.
There is no prebuilt app yet, so you build it from a source checkout (see [CONTRIBUTING.md](../CONTRIBUTING.md) for the setup; it needs the Xcode Command Line Tools):

```sh
npm run build:app      # builds dist-app/Overnote.app, signed for this Mac only
npm run app:install    # builds it and copies it to /Applications
open /Applications/Overnote.app
```

`app:install` refuses to replace a running app: quit it first from its menu bar item.
The menu bar item offers Show or Hide Overnote, New Note, Launch at Login, About Overnote, and Quit Overnote.
The app is signed ad hoc, not notarized, so it is meant for the Mac that built it.

The app and the extension share one database and one running panel:
- While the app runs, the extension's commands (Toggle Overnote, Search Notes, the menu bar, and the rest) use the app's panel and never restart it.
- When the app starts while the extension's panel runs, the app takes over.
- When you quit the app, the extension starts its own panel again on its next command.

If you used the extension before this version, update it and run any of its commands once before the app's first start, so your notes move to the shared folder (see below).

## Back up and restore

Your notes live in one SQLite file, `notes.sqlite`, in `~/Library/Application Support/Overnote`, which the extension and the app share.
Releases up to 0.5.0 kept it in the extension's Raycast support folder; the first start of a newer release copies it into the shared folder once, and leaves the original untouched.
Backups are kept in `~/Library/Application Support/Overnote/backups`.

- Overnote writes a backup once a day while it runs, and before every update, database upgrade, and restore.
- It keeps the latest 10 backups, plus the newest one from each of the last 4 weeks.
- Each backup is a complete, ordinary SQLite file named like `notes-20261015T093000.000Z-v0.3.0-daily.sqlite`: the time in UTC, the Overnote version, and why it was written.

In Search Notes (any note's action panel) and in the menu bar:

- **Back Up Notes Now** writes a backup right away.
- **Restore Notes from Backup** lists the backups, newest first.
  Restoring one replaces every note, after Overnote backs up the current notes, so a restore can itself be undone.
- **Reveal Backups Folder** opens the folder in Finder.

Removing the extension leaves your notes in the shared folder, so installing it again finds them.
If `notes.sqlite` is gone but backups exist, Overnote starts with no notes, never overwrites anything, and Search Notes shows **Restore Notes from Backup** as the first item until you restore or dismiss it.

## Uninstall

1. Open Raycast Settings, go to Extensions, select Overnote, and remove it.
2. Delete the folder you installed from.

3. If you installed the app, quit it from its menu bar item, turn off Launch at Login there first if you turned it on, and move `/Applications/Overnote.app` to the Trash.

Your notes and backups stay in `~/Library/Application Support/Overnote`, and installing again finds them.
To remove every trace, delete that folder too, along with the extension's support folder, `~/Library/Application Support/com.raycast.macos/extensions/overnote`, if Raycast left it behind.

## Troubleshooting

- **"Node.js 22 or later is required"**: install the current Node.js LTS from [nodejs.org](https://nodejs.org) and run the installer again.
- **"The prebuilt helper is missing or does not match"**: the download was damaged or changed; download the zip again.
- **Overnote does not show up in Raycast**: make sure Raycast is running and signed in, then run `npm run install-extension` again.
- **"This folder is not an installed release"**: `npm run update-extension` works only in a folder unzipped from a release; in a git checkout, use `git pull` and `npm run install-extension`.
