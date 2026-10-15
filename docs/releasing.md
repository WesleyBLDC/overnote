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

The extension zip holds one folder, `overnote/`, with the manifest and lockfile, `src/`, `packages/core`, the editor workspace sources (npm needs every workspace in the lockfile), the installer scripts, and `assets/` with the prebuilt helper, its checksum, and the prebuilt editor.
It leaves out tests, the helper's Swift sources, build output, and `node_modules`.
A marker file, `assets/prebuilt.json`, tells `scripts/prepare-assets.sh` to use the prebuilt assets and never rebuild them, so installing needs only Node 22+ and a signed-in Raycast.

## Steps

1. Make sure `main` is green in CI and `npm run verify` passes locally.
2. If the helper changed, bump `helper/VERSION` and `HelperVersion.current` together (`scripts/build-helper.sh` refuses a mismatch).
3. Add the release to `CHANGELOG.md`.
4. Optionally, check the packaging locally:

   ```sh
   npm run build:editor && npm run build:helper
   bash scripts/package-release.sh 0.3.0 /tmp/overnote-release
   ```

5. Tag and push:

   ```sh
   git tag -a v0.3.0 -m "Overnote 0.3.0"
   git push origin v0.3.0
   ```

6. Watch the Release workflow in the Actions tab.
   It builds the editor and the helper, runs the helper smoke test, packages the zip, installs from that zip the way a user does (without Raycast), and then publishes the release.
7. Open the release page and check the files and the notes.

A tag with a suffix, such as `v0.3.0-beta.1`, is published as a prerelease.
Rerunning the workflow for the same tag replaces the files and the notes of the existing release.

## Signing

The helper is signed ad hoc with the hardened runtime and is not notarized.
Downloaded copies get the quarantine attribute, which the installer and the extension's launcher clear only after the helper matches its checksum.
Notarization would need an Apple Developer ID and repository secrets, which this workflow does not use yet.

## Repository settings

- The workflow publishes with the built in `GITHUB_TOKEN`; it needs no secrets.
  If the repository restricts the default token to read only, the workflow's own `permissions: contents: write` still grants what it needs, unless an organization policy forbids it.
- The CI workflow honors one optional repository variable, `OVERNOTE_WINDOW_E2E`.
  Set it to `0` only if a runner image ever loses its GUI session, which `scripts/e2e-window.sh` needs.
