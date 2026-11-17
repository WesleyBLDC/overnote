# Installing Overnote

Overnote is a floating Markdown notepad for macOS.
It runs as `Overnote.app`, a menu bar app, and it can also run as a Raycast extension.
Use either one, or both: they share the same notes and the same panel.

Both need an Apple silicon Mac on macOS 14 Sonoma or later and [Node.js](https://nodejs.org) 22 or later.
Intel Macs need a source build with `OVERNOTE_HELPER_ARCHES="arm64 x86_64"` (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Overnote.app

`Overnote.app` lives in the menu bar, has no Dock icon, and shows or hides the panel with its own hotkey, ⌃⌥N.
It does not need Raycast.

### Install the app

There is no prebuilt app download yet, so you build it from a source checkout.
That needs the Xcode Command Line Tools (`xcode-select --install`); full Xcode is not required.

```sh
git clone https://github.com/WesleyBLDC/overnote.git
cd overnote
npm install
npm run app:install    # builds dist-app/Overnote.app and copies it to /Applications
open /Applications/Overnote.app
```

`npm run build:app` builds `dist-app/Overnote.app` without installing it.
The app is signed ad hoc, not notarized, so it is meant for the Mac that built it.
Turn on Launch at Login from its menu bar item to start it with your Mac.

### Update the app

Quit the app first, since `app:install` refuses to replace a running app, then in your checkout:

```sh
git pull --ff-only
npm install
npm run app:install
open /Applications/Overnote.app
```

### Show, hide, and quit

- The menu bar item offers Show or Hide Overnote, New Note, Launch at Login, About Overnote, and Quit Overnote.
- ⌃⌥N, ⎋, ⌘W, ⌘M, and the red dot hide the panel; the app keeps running.
- ⌘Q, or Quit Overnote in All actions (⌘K), quits the app.
  Text you typed is saved first.

## Raycast extension (optional)

Overnote also installs as a Raycast extension, for people who prefer Raycast or want its commands (Search Notes, Create Note, the menu bar, and the rest).
It is not in the Raycast Store yet.
Each GitHub release carries a zip with everything prebuilt, so you install it without building anything.
Besides a Mac and Node.js, it needs [Raycast](https://www.raycast.com) installed and signed in, and no Xcode tools.

### Install the extension

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
4. Open Raycast Settings, go to Extensions, find **Toggle Overnote**, and record a hotkey for it (for example ⌥N, which does not clash with the app's ⌃⌥N).
5. Press your hotkey to open the panel.

macOS marks downloaded files with a quarantine attribute, and Gatekeeper refuses to start a quarantined helper that is not notarized.
You do not need to do anything about it: the installer and the extension's launcher check the helper against its `.sha256` checksum and only then clear the attribute.
A helper that does not match its checksum is never started.

To check a download yourself, compare `shasum -a 256 overnote-<version>.zip` with the line in the release's `SHA256SUMS`.

### Update the extension

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

## Using the app and the extension together

The app and the extension share one database and one running panel:

- While the app runs, the extension's commands (Toggle Overnote, Search Notes, the menu bar, and the rest) use the app's panel and never restart it.
- When the app starts while the extension's panel runs, the app takes over.
- When you quit the app, the extension starts its own panel again on its next command.

Text you typed just before a takeover, a quit, or an update is saved before the panel closes.

## Back up and restore

Your notes live in one SQLite file, `notes.sqlite`, in `~/Library/Application Support/Overnote`, which the extension and the app share.
Releases up to 0.5.0 kept it in the extension's Raycast support folder; a newer release copies it into the shared folder once, as long as the shared folder holds no note yet, and leaves the original untouched.
Backups are kept in `~/Library/Application Support/Overnote/backups`.

- Overnote writes a backup once a day while it runs, and before every update, database upgrade, restore, and import of older notes.
- It keeps the latest 10 backups, plus the newest one from each of the last 4 weeks.
- Each backup is a complete, ordinary SQLite file named like `notes-20261015T093000.000Z-v0.3.0-daily.sqlite`: the time in UTC, the Overnote version, and why it was written.

In Settings (⌘,), **Back up now** writes a backup and **Show in Finder** opens the data folder.
With the extension, Search Notes (any note's action panel) and its menu bar also offer:

- **Back Up Notes Now** writes a backup right away.
- **Restore Notes from Backup** lists the backups, newest first.
  Restoring one replaces every note, after Overnote backs up the current notes, so a restore can itself be undone.
- **Reveal Backups Folder** opens the folder in Finder.

Removing the app or the extension leaves your notes in the shared folder, so installing again finds them.
If `notes.sqlite` is gone but backups exist, Overnote starts with no notes and never overwrites anything; with the extension, Search Notes shows **Restore Notes from Backup** as the first item until you restore or dismiss it.

## Uninstall

- **The app:** turn off Launch at Login in its menu bar item if you turned it on, quit it, and move `/Applications/Overnote.app` to the Trash.
- **The extension:** open Raycast Settings, go to Extensions, select Overnote, and remove it; then delete the folder you installed from.

Your notes and backups stay in `~/Library/Application Support/Overnote`, and installing again finds them.
To remove every trace, delete that folder too, along with the extension's support folder, `~/Library/Application Support/com.raycast.macos/extensions/overnote`, if Raycast left it behind.

## Troubleshooting

- **"Overnote.app is running"** from `npm run app:install`: quit the app from its menu bar item, then run it again.
- **"Node.js 22 or later is required"**: install the current Node.js LTS from [nodejs.org](https://nodejs.org) and run the installer again.
- **"The prebuilt helper is missing or does not match"**: the download was damaged or changed; download the zip again.
- **Overnote does not show up in Raycast**: make sure Raycast is running and signed in, then run `npm run install-extension` again.
- **"This folder is not an installed release"**: `npm run update-extension` works only in a folder unzipped from a release; in a git checkout, use `git pull` and `npm run install-extension`.
