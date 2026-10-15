#!/bin/bash
# Packages a release from a checkout whose editor and helper are already built
# (npm run build:editor, scripts/build-helper.sh). Used by .github/workflows/release.yml and
# runnable locally to check a release before tagging.
#
#   scripts/package-release.sh <version> <out-dir>
#
# Writes to <out-dir>:
#   overnote-<version>.zip           the extension, ready for `npm run install-extension`:
#                                    sources plus the PREBUILT helper and editor, so installing
#                                    needs only Node 22+ and Raycast (no Xcode tools)
#   OvernoteHelper-<version>.zip     the bare universal helper, executable bit kept
#   OvernoteHelper.sha256            the helper's checksum, as written by build-helper.sh
#   SHA256SUMS                       checksums of every file above
#   release-notes.md                 a source summary for the release body
#
# The zip holds one folder, `overnote/`. It leaves out tests, helper sources, build output,
# and node_modules.
set -euo pipefail

VERSION="${1:?usage: scripts/package-release.sh <version> <out-dir>}"
OUT="${2:?usage: scripts/package-release.sh <version> <out-dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '[package] %s\n' "$*"; }
die() { printf '[package] %s\n' "$*" >&2; exit 1; }

BIN="assets/bin/OvernoteHelper"
[[ -x "$BIN" && -f "$BIN.sha256" ]] || die "Helper not built: run scripts/build-helper.sh first"
[[ -f assets/editor/index.html ]] || die "Editor not built: run npm run build:editor first"
[[ "$(shasum -a 256 "$BIN" | cut -d' ' -f1)" == "$(cut -d' ' -f1 "$BIN.sha256")" ]] || die "$BIN does not match its .sha256"
[[ "$(lipo -archs "$BIN")" == *arm64* && "$(lipo -archs "$BIN")" == *x86_64* ]] || die "$BIN is not universal: $(lipo -archs "$BIN")"
codesign --verify --strict "$BIN" || die "$BIN signature does not verify"

HELPER_VERSION="$("$BIN" --version)"
HELPER_SHA="$(cut -d' ' -f1 "$BIN.sha256")"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/overnote"
mkdir -p "$PKG"

# Copies paths relative to the root, keeping their layout, skipping development artifacts.
copy() {
  rsync -a --relative \
    --exclude node_modules --exclude .DS_Store --exclude __tests__ --exclude __mocks__ \
    --exclude tests --exclude unit --exclude test-results --exclude playwright-report \
    --exclude '*.test.ts' --exclude '*.log' \
    "$@" "$PKG/"
}

copy package.json package-lock.json tsconfig.json eslint.config.js .prettierrc LICENSE README.md CHANGELOG.md
copy src packages/core/package.json packages/core/tsconfig.json packages/core/src
# The editor workspace stays (npm ci needs every workspace in the lockfile), without its tests.
copy editor/package.json editor/tsconfig.json editor/index.html editor/vite.config.ts editor/src
copy scripts/prepare-assets.sh scripts/install-extension.sh
copy assets/extension-icon.png assets/bin/OvernoteHelper assets/bin/OvernoteHelper.sha256 assets/editor
[[ -d media ]] && copy media

# Marks the assets as prebuilt, so prepare-assets.sh never tries to rebuild them.
cat > "$PKG/assets/prebuilt.json" <<EOF
{
  "version": "$VERSION",
  "commit": "$COMMIT",
  "helperVersion": "$HELPER_VERSION",
  "helperSha256": "$HELPER_SHA"
}
EOF

chmod 755 "$PKG/assets/bin/OvernoteHelper" "$PKG"/scripts/*.sh
rm -f "$OUT/overnote-$VERSION.zip" "$OUT/OvernoteHelper-$VERSION.zip"
# Info-ZIP keeps Unix permissions, so the helper stays executable; -X drops extra attributes.
(cd "$STAGE" && zip -q -r -X "$OUT/overnote-$VERSION.zip" overnote)
(cd assets/bin && zip -q -X "$OUT/OvernoteHelper-$VERSION.zip" OvernoteHelper)
cp "$BIN.sha256" "$OUT/OvernoteHelper.sha256"

# Check what we ship: the helper is executable inside both zips and matches its checksum.
for zipfile in "$OUT/overnote-$VERSION.zip" "$OUT/OvernoteHelper-$VERSION.zip"; do
  zipinfo "$zipfile" | grep -E 'OvernoteHelper$' | grep -q '^-rwxr-xr-x' || die "the helper in $(basename "$zipfile") is not executable"
done
CHECK="$(mktemp -d)"
unzip -q "$OUT/OvernoteHelper-$VERSION.zip" -d "$CHECK"
[[ "$(shasum -a 256 "$CHECK/OvernoteHelper" | cut -d' ' -f1)" == "$HELPER_SHA" ]] || die "the zipped helper does not match its checksum"
rm -rf "$CHECK"

(cd "$OUT" && shasum -a 256 "overnote-$VERSION.zip" "OvernoteHelper-$VERSION.zip" OvernoteHelper.sha256 > SHA256SUMS)

FILES="$(cd "$STAGE" && find overnote -type f | sort)"
cat > "$OUT/release-notes.md" <<EOF
## Install

1. Download \`overnote-$VERSION.zip\` below and unzip it.
2. In Terminal: \`cd overnote\` (in the unzipped folder), then \`npm run install-extension\`.
3. In Raycast Settings, bind a hotkey to **Toggle Overnote**.

You need macOS 14+, Node.js 22+, and a signed-in Raycast. The Xcode tools are not needed: the zip carries a prebuilt helper and editor.
Full steps: [docs/install.md](https://github.com/${GITHUB_REPOSITORY:-WesleyBLDC/overnote}/blob/$COMMIT/docs/install.md).

## Source summary

| | |
|---|---|
| Commit | \`$COMMIT\` |
| Helper version | \`$HELPER_VERSION\` |
| Helper architectures | \`$(lipo -archs "$BIN")\` |
| Helper SHA-256 | \`$HELPER_SHA\` |
| Helper signature | ad-hoc, hardened runtime, identifier \`dev.overnote.helper\` |
| Built on | macOS $(sw_vers -productVersion), $(swift --version 2>/dev/null | head -n 1) |
| Node | $(node --version) |

## Checksums

\`\`\`
$(cat "$OUT/SHA256SUMS")
\`\`\`

<details><summary>Files in overnote-$VERSION.zip ($(echo "$FILES" | wc -l | tr -d ' '))</summary>

\`\`\`
$FILES
\`\`\`

</details>
EOF

log "Wrote $OUT:"
(cd "$OUT" && ls -l)
