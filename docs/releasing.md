# Releasing Overnote

A release is a git tag.
Pushing a tag that starts with `v` runs `.github/workflows/release.yml`, which builds everything on a GitHub macOS runner and publishes a GitHub release.

## What a release contains

| File | Contents |
|---|---|
| `overnote-<version>.zip` | The extension, ready to install with `npm run install-extension` (see [install.md](install.md)) |
| `SHA256SUMS` | The checksum of the zip |

The release notes list the install steps, then the commit, helper version, database schema, architectures, checksum, and toolchain the release was built with, and the files in the zip.

The extension zip holds one folder, `overnote/`: the manifest and lockfile, `src/`, `packages/core`, the editor workspace sources (npm needs every workspace in the lockfile), the install and update scripts, and `assets/` with the prebuilt helper, its checksum, and the prebuilt editor.
It leaves out tests, the helper's Swift sources, build output, and `node_modules`.

`assets/prebuilt.json` marks a release install.
It tells `scripts/prepare-assets.sh` to use the prebuilt assets and never rebuild them, so installing needs only Node 22 or later and a signed-in Raycast.
It also records the release `version`, which Check for Updates and `npm run update-extension` read, and the `schemaVersion` the helper writes (`OvernoteHelper --schema-version`), which the update's rollback guard compares with the database.

## Steps

1. Make sure `npm run verify` passes locally on `main`, on macOS with Apple silicon.
2. Set only `helper/VERSION` to the release version.
   `helper/VERSION` is the single source of truth for the helper version.
   `scripts/generate-helper-version.sh` generates the Swift `HelperVersion.current` constant from `helper/VERSION` into the gitignored `helper/Sources/OvernoteCore/GeneratedVersion.swift`, and nobody edits that constant by hand.
   `scripts/build-helper.sh` refuses a mismatch, and the launcher restarts a running helper whose version differs, so every release that changes the helper needs a new version.
   The helper ships arm64 by default.
   A universal binary remains available only by setting `OVERNOTE_HELPER_ARCHES`, for example `OVERNOTE_HELPER_ARCHES="arm64 x86_64"`, when running `scripts/build-helper.sh`, and release packaging refuses a universal binary.
3. Run `bash scripts/check-version.sh 0.3.0`.
   The Release workflow runs the same check on the tag, and again on the packaged zip, and stops before publishing if the tag, `helper/VERSION`, the generated `HelperVersion.current`, or the zip's `prebuilt.json` disagree.
   `CHANGELOG.md` is not checked: it follows the Raycast Store format, `## [Title] - {PR_MERGE_DATE}`, and the maintainer keeps it.
4. Optionally, check the packaging locally:

   ```sh
   npm run build:editor && npm run build:helper
   bash scripts/package-release.sh 0.3.0 /tmp/overnote-release
   bash scripts/check-release.sh /tmp/overnote-release/overnote-0.3.0.zip
   ```

   `scripts/package-release.sh` ships the arm64 slice only and refuses any other architecture set.
   `scripts/check-release.sh` installs the zip the way a browser download arrives, quarantined and with the Xcode tools stubbed out, and runs the helper headless; it never shows the panel or talks to Raycast, so it is safe on a workstation (`--help` lists the steps).

5. Tag and push:

   ```sh
   git tag -a v0.3.0 -m "Overnote 0.3.0"
   git push origin v0.3.0
   ```

6. Watch the Release workflow in the Actions tab.
   It checks the version, builds the editor and the helper, runs the helper smoke test, packages the zip, checks it as a browser download, and publishes the release.
7. Open the release page and check the files and the notes.
8. On your own install, run Check for Updates, then `npm run update-extension` in the install folder, and check that your notes and the new version are there.

`scripts/e2e-update.sh`, part of `npm run verify`, covers the update path end to end with fake releases: install, update, rollback guard, backups, and restore after removal.

A tag with a suffix, such as `v0.3.0-beta.1`, is published as a prerelease.
Rerunning the workflow for the same tag replaces the files and the notes of the existing release.

## Raycast Store copy

The Store builds an extension from the files committed to its repository, so a Store submission needs the built helper and editor committed, while `main` stays code only.
`scripts/prepare-store.sh <out-dir>` writes that copy to `<out-dir>/overnote`:

- the sources, plus `helper/` and `scripts/build-helper.sh` and `scripts/generate-helper-version.sh`, so reviewers can rebuild the helper and compare it with `assets/bin/OvernoteHelper.sha256`;
- the prebuilt arm64 helper and editor, with `assets/prebuilt.json`;
- `metadata/` with the Store screenshots, and the README without its GitHub install and development sections;
- no Check for Updates command and no install or update scripts, because the Store updates the extension itself.

Add `--check` to also run `npm ci`, `ray lint`, and `ray build` inside the copy.
Before submitting, take real Window Captures of Search Notes in Raycast and add them to `metadata/` (see the Store's screenshot guidelines), then run `npm run publish` inside the copy.

## Signing

The helper is signed ad hoc with the hardened runtime and is not notarized.
Downloaded copies get the quarantine attribute, which the installer and the extension's launcher clear only after the helper matches its checksum.
`spctl --assess --type execute` rejects the helper both before and after the attribute is cleared, because an ad hoc signature has no Developer ID; that is expected, and the helper still runs once the attribute is gone.
Notarization would need an Apple Developer ID and repository secrets, which this workflow does not use yet.

## Repository settings

- The workflow publishes with the built-in `GITHUB_TOKEN` and needs no secrets.
  If the repository restricts the default token to read only, the workflow's own `permissions: contents: write` still grants what it needs, unless an organization policy forbids it.
