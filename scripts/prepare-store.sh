#!/bin/bash
# Prepares a Raycast Store copy of the extension, ready for `npm run publish` from that copy.
# The Store builds extensions from committed files, so this copy carries the prebuilt helper
# and editor next to the sources they are built from. The main branch stays code only.
#
#   scripts/prepare-store.sh <out-dir> [--check]
#
# Needs the built editor and helper (npm run build:editor, scripts/build-helper.sh).
#
# Writes <out-dir>/overnote with:
#   - the manifest, lockfile, configs, src/, packages/core, and the editor workspace sources
#   - helper/ (the Swift sources) and scripts/build-helper.sh, so the binary can be rebuilt
#   - assets/bin/OvernoteHelper with its .sha256, and the built editor in assets/editor/
#   - assets/prebuilt.json, so the build never tries to rebuild those assets
#   - README.md without its GitHub only parts, CHANGELOG.md, LICENSE, media/, and metadata/
# It leaves out Check for Updates and the install and update scripts (the Store updates the
# extension itself), tests, and anything ignored by git.
#
# Options:
#   --check  also run npm ci, ray lint, and ray build -e dist inside the copy
set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
  exit 2
}

OUT=""
CHECK=0
while (($#)); do
  case "$1" in
    --check) CHECK=1 ;;
    -h | --help | -*) usage ;;
    *)
      [[ -z "$OUT" ]] || usage
      OUT="$1"
      ;;
  esac
  shift
done
[[ -n "$OUT" ]] || usage

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '[prepare-store] %s\n' "$*"; }
die() {
  printf '[prepare-store] %s\n' "$*" >&2
  exit 1
}

BIN="assets/bin/OvernoteHelper"
[[ -x "$BIN" && -f "$BIN.sha256" ]] || die "Helper not built: run scripts/build-helper.sh first"
[[ -f assets/editor/index.html ]] || die "Editor not built: run npm run build:editor first"
[[ "$(shasum -a 256 "$BIN" | cut -d' ' -f1)" == "$(cut -d' ' -f1 "$BIN.sha256")" ]] || die "$BIN does not match its .sha256"
[[ "$(lipo -archs "$BIN")" == *arm64* && "$(lipo -archs "$BIN")" == *x86_64* ]] || die "$BIN is not universal: $(lipo -archs "$BIN")"
codesign --verify --strict "$BIN" || die "$BIN signature does not verify"
HELPER_VERSION="$("$BIN" --version)"
[[ "$HELPER_VERSION" == "$(tr -d '[:space:]' <helper/VERSION)" ]] || die "$BIN is $HELPER_VERSION, helper/VERSION says otherwise: rebuild it"
SCHEMA_VERSION="$("$BIN" --schema-version)"
HELPER_SHA="$(cut -d' ' -f1 "$BIN.sha256")"
COMMIT="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
[[ -z "$(git status --porcelain 2>/dev/null || true)" ]] || log "Note: the working tree has uncommitted changes; the copy records commit $COMMIT"

shopt -s nullglob
shots=(metadata/*.png)
((${#shots[@]} >= 3 && ${#shots[@]} <= 6)) || die "metadata/ needs 3 to 6 screenshots (found ${#shots[@]})"
for shot in "${shots[@]}"; do
  size="$(sips -g pixelWidth -g pixelHeight "$shot" | awk '/pixelWidth/ { w = $2 } /pixelHeight/ { h = $2 } END { print w "x" h }')"
  [[ "$size" == "2000x1250" ]] || die "$shot is $size, the Store needs 2000x1250"
done

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
COPY="$OUT/overnote"
MARKER="$COPY/.overnote-store-copy"
if [[ -e "$COPY" ]]; then
  [[ -f "$MARKER" ]] || die "$COPY exists and is not a Store copy made by this script; remove it first"
  find "$COPY" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .git -exec rm -rf {} +
fi
mkdir -p "$COPY"

# Copies paths relative to the root, keeping their layout, skipping development artifacts.
copy() {
  rsync -a --relative \
    --exclude node_modules --exclude .DS_Store --exclude .build --exclude __tests__ --exclude __mocks__ \
    --exclude tests --exclude Tests --exclude unit --exclude test-results --exclude playwright-report \
    --exclude '*.test.ts' --exclude '*.log' \
    "$@" "$COPY/"
}
copy package.json package-lock.json tsconfig.json eslint.config.js .prettierrc .prettierignore LICENSE CHANGELOG.md
copy src packages/core/package.json packages/core/tsconfig.json packages/core/src
copy editor/package.json editor/tsconfig.json editor/index.html editor/vite.config.ts editor/src
copy helper/Package.swift helper/VERSION helper/Sources
[[ -f helper/Package.resolved ]] && copy helper/Package.resolved
copy scripts/prepare-assets.sh scripts/build-helper.sh
copy assets/extension-icon.png assets/bin/OvernoteHelper assets/bin/OvernoteHelper.sha256 assets/editor
[[ -f assets/extension-icon@dark.png ]] && copy assets/extension-icon@dark.png
copy media metadata
touch "$MARKER"

# Check for Updates and its update channel belong to GitHub installs; the Store updates the
# extension on its own.
rm -f "$COPY/src/check-for-updates.ts" "$COPY/src/domain/updates.ts"
node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.description = "An open-source, extensible floating Markdown notepad, one hotkey away, with local notes and daily backups.";
  manifest.commands = manifest.commands.filter((command) => command.name !== "check-for-updates");
  for (const name of ["install-extension", "update-extension", "prepare-store", "verify", "test"]) delete manifest.scripts[name];
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");' "$COPY/package.json"
if grep -rqE "check-for-updates|domain/updates" "$COPY/src"; then
  die "src/ still refers to Check for Updates"
fi

# README.md without the blocks and lines marked for GitHub only.
awk '
  /<!-- store:remove -->/ { skip = 1; next }
  /<!-- \/store:remove -->/ { skip = 0; next }
  skip || /<!-- store:remove-line -->/ { next }
  { print }
' README.md >"$COPY/README.md"
grep -q "store:" "$COPY/README.md" && die "README.md has an unbalanced store marker"

cat >"$COPY/assets/prebuilt.json" <<EOF
{
  "version": "$HELPER_VERSION",
  "schemaVersion": $SCHEMA_VERSION,
  "commit": "$COMMIT",
  "helperVersion": "$HELPER_VERSION",
  "helperSha256": "$HELPER_SHA",
  "channel": "store"
}
EOF

cat >"$COPY/.gitignore" <<'EOF'
node_modules/
dist/
raycast-env.d.ts
helper/.build/
.DS_Store
*.log
.overnote-store-copy
EOF

chmod 755 "$COPY/assets/bin/OvernoteHelper" "$COPY"/scripts/*.sh
[[ "$(shasum -a 256 "$COPY/assets/bin/OvernoteHelper" | cut -d' ' -f1)" == "$HELPER_SHA" ]] || die "the copied helper does not match its checksum"

log "Wrote $COPY"
log "Helper $HELPER_VERSION, schema $SCHEMA_VERSION, SHA-256 $HELPER_SHA, from commit $COMMIT"
log "Screenshots: ${shots[*]}"

if ((CHECK)); then
  log "Checking the copy: npm ci, ray lint, ray build"
  (
    cd "$COPY"
    npm ci --no-audit --no-fund
    npx ray lint
    npx ray build -e dist -o "$OUT/raybuild"
  )
  rm -rf "$OUT/raybuild"
  log "The copy passes ray lint and ray build"
fi

cat <<EOF

Next, to submit (after real Window Captures of Search Notes replace or join metadata/):
  cd '$COPY'
  npm ci && npm run build
  npm run publish
EOF
