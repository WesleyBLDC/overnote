# Installing Overnote from a release

Overnote is not in the Raycast Store yet.
Each GitHub release carries a zip with everything prebuilt, so you can install it without building anything.

## What you need

- macOS 14 Sonoma or later.
- [Raycast](https://www.raycast.com), installed and signed in.
- [Node.js](https://nodejs.org) 22 or later.

You do not need Xcode or the Xcode Command Line Tools: the zip carries a prebuilt native helper and a prebuilt editor.

## Steps

1. Open the [Releases page](https://github.com/WesleyBLDC/overnote/releases) and download `overnote-<version>.zip` from the latest release.
2. Unzip it (double click it in Finder), which gives you a folder named `overnote`.
3. In Terminal, go into that folder and run the installer:

   ```sh
   cd ~/Downloads/overnote
   npm run install-extension
   ```

   It installs the dependencies, checks the prebuilt helper against its checksum, and registers the extension with Raycast.
   It takes about a minute and is a one time step.
4. Open Raycast Settings, go to Extensions, find **Toggle Overnote**, and record a hotkey for it.
   Overnote ships with no default hotkey, so pick whatever feels natural (for example ⌥N).
5. Press your hotkey to open the panel.

Keep the `overnote` folder where it is: Raycast runs the extension from it.
If you want it somewhere other than Downloads, move the folder first and run the installer from the new place.

## Downloaded files and Gatekeeper

macOS marks downloaded files with a quarantine attribute, and Gatekeeper refuses to start a quarantined helper that is not notarized.
You do not need to do anything about it.
The installer checks the helper against its `.sha256` checksum and only then clears the attribute, and the extension's launcher does the same every time it starts the helper.
A helper that does not match its checksum is never started.

## Updating

Download the new release zip, unzip it in place of the old folder, and run `npm run install-extension` again.
Your notes live in Raycast's support directory for the extension, not in this folder, so they are kept.

## Checking a download

Every release lists the SHA-256 of each file in `SHA256SUMS`.
To check the zip:

```sh
shasum -a 256 overnote-<version>.zip
```

The helper also ships on its own as `OvernoteHelper-<version>.zip` with `OvernoteHelper.sha256`, for people who build the extension from source without the Command Line Tools.
Put the unzipped `OvernoteHelper` and `OvernoteHelper.sha256` into `assets/bin/` of a checkout.

## Troubleshooting

- **"Node.js 22 or later is required"**: install the current Node.js LTS from [nodejs.org](https://nodejs.org) and run the installer again.
- **"The prebuilt helper is missing or does not match"**: the download was damaged or changed; download the zip again.
- **Overnote does not show up in Raycast**: make sure Raycast is running and signed in, then run `npm run install-extension` again.
