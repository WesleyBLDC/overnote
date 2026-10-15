# Releasing Overnote

A release is a git tag.
Pushing a tag that starts with `v` runs `.github/workflows/release.yml`, which builds everything on a GitHub macOS runner and publishes a GitHub release.

## What a release contains

| File | Contents |
|---|---|
| `overnote-<version>.zip` | The extension, ready to install with `npm run install-extension` (see [install.md](install.md)) |
| `OvernoteHelper-<version>.zip` | The universal (arm64 and x86_64) helper on its own, with its executable bit |
| `OvernoteHelper.sha256` | The helper's SHA-256, the same file `scripts/build-helper.sh` writes |
| `SHA256SUMS` | Checksums of the three files above |

The release body is a source summary: the commit, the helper version, architectures, checksum, the macOS and Swift toolchain it was built with, and the list of files in the zip.

The extension zip holds one folder, `overnote/`, with the manifest and lockfile, `src/`, `packages/core`, the editor workspace sources (npm needs every workspace in the lockfile), the install and update scripts, and `assets/` with the prebuilt helper, its checksum, and the prebuilt editor.
It leaves out tests, the helper's Swift sources, build output, and `node_modules`.
A marker file, `assets/prebuilt.json`, tells `scripts/prepare-assets.sh` to use the prebuilt assets and never rebuild them, so installing needs only Node 22+ and a signed-in Raycast.
It also records the release `version`, which Check for Updates and `npm run update-extension` read, and the `schemaVersion` the helper writes (`OvernoteHelper --schema-version`), which the update's rollback guard compares with the database.

## Steps

1. Make sure `main` is green in CI and `npm run verify` passes locally.
2. Bump `helper/VERSION` and `HelperVersion.current` to the release version together (`scripts/build-helper.sh` refuses a mismatch).
   The launcher restarts a running helper whose version differs, so every release that changes the helper needs a new version.
3. Add the release to `CHANGELOG.md`, with a newest heading that names the version, for example `## [0.3.0] - {PR_MERGE_DATE}`.
   `scripts/check-version.sh 0.3.0` checks steps 2 and 3 locally; the Release workflow runs it on the tag and fails before publishing if the tag, `helper/VERSION`, `HelperVersion.current`, the newest `CHANGELOG.md` heading, or the zip's `prebuilt.json` disagree.
4. Optionally, check the packaging locally:

   ```sh
   npm run build:editor && npm run build:helper
   bash scripts/package-release.sh 0.3.0 /tmp/overnote-release
   bash scripts/check-release.sh /tmp/overnote-release/overnote-0.3.0.zip
   ```

   `scripts/check-release.sh` takes a local zip (checked against the `SHA256SUMS` next to it) or a release URL (checked against the `SHA256SUMS` of the same release).
   It quarantines every file the way a browser download does, installs with the Xcode tools stubbed out, starts the helper headless through the zip's own launcher, creates and lists a note, and checks that the launcher cleared the quarantine and that the signature verifies.
   It never shows the panel and never talks to Raycast, so it is safe to run on a workstation, and it reports what Gatekeeper (`spctl`) says before and after.
   Run it against a published release with `bash scripts/check-release.sh https://github.com/WesleyBLDC/overnote/releases/download/v0.3.0/overnote-0.3.0.zip`.

5. Tag and push:

   ```sh
   git tag -a v0.3.0 -m "Overnote 0.3.0"
   git push origin v0.3.0
   ```

6. Watch the Release workflow in the Actions tab.
   It checks the version, builds the editor and the helper, runs the helper smoke test, packages the zip, checks the packaged version and that zip as a browser download with `scripts/check-release.sh` (headless, without Raycast), and then publishes the release.
7. Open the release page and check the files and the notes.
8. On your own install, run Check for Updates, then `npm run update-extension` in the install folder, and check that your notes and the new version are there.

`scripts/e2e-update.sh` (part of `npm run verify` and CI) covers the update path end to end with fake releases: install, update, rollback guard, backups, and restore after removal.

A tag with a suffix, such as `v0.3.0-beta.1`, is published as a prerelease.
Rerunning the workflow for the same tag replaces the files and the notes of the existing release.

## Signing

The helper is signed ad hoc with the hardened runtime and is not notarized.
Downloaded copies get the quarantine attribute, which the installer and the extension's launcher clear only after the helper matches its checksum.
`spctl --assess --type execute` rejects the helper both before and after the attribute is cleared, because an ad hoc signature has no Developer ID; that is expected, and the helper still runs once the attribute is gone.
Notarization would need an Apple Developer ID and repository secrets, which this workflow does not use yet.

## Repository settings

- The workflow publishes with the built in `GITHUB_TOKEN`; it needs no secrets.
  If the repository restricts the default token to read only, the workflow's own `permissions: contents: write` still grants what it needs, unless an organization policy forbids it.
- The CI workflow honors one optional repository variable, `OVERNOTE_WINDOW_E2E`.
  Set it to `0` only if a runner image ever loses its GUI session, which `scripts/e2e-window.sh` needs.
