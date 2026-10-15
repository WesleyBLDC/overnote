#!/bin/bash
# Makes sure the two built assets the extension ships are present and current:
#   assets/bin/OvernoteHelper (+ .sha256)  the native helper
#   assets/editor/                          the editor bundle
#
# Used by `npm run dev`, `npm run build`, and `npm run install-extension`.
#
# Each asset is built only when it has to be:
#   - In a release zip (assets/prebuilt.json is present, helper/ and the editor build inputs
#     may be absent), the prebuilt assets are always used. The helper must match its
#     checksum; nothing needs the Xcode Command Line Tools.
#   - In a git checkout, the helper is rebuilt when it is missing, fails its checksum,
#     reports a version other than helper/VERSION, or is older than any helper source file.
#     The editor is rebuilt when it is missing or older than any of its inputs.
#
# Set OVERNOTE_FORCE_BUILD=1 to rebuild both regardless (needs the Command Line Tools).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BIN="assets/bin/OvernoteHelper"
SUM="$BIN.sha256"
EDITOR_INDEX="assets/editor/index.html"
MARKER="assets/prebuilt.json"
FORCE="${OVERNOTE_FORCE_BUILD:-0}"

log() { printf '[prepare-assets] %s\n' "$*"; }
die() { printf '[prepare-assets] %s\n' "$*" >&2; exit 1; }

# True when any file under the given paths is newer than the reference file.
newer_than() {
  local reference="$1"
  shift
  local path
  for path in "$@"; do
    [[ -e "$path" ]] || continue
    if [[ -n "$(find "$path" -type f -newer "$reference" -not -path '*/.build/*' -not -path '*/node_modules/*' -print -quit)" ]]; then
      return 0
    fi
  done
  return 1
}

checksum_ok() {
  [[ -f "$BIN" && -f "$SUM" ]] || return 1
  [[ "$(shasum -a 256 "$BIN" | cut -d' ' -f1)" == "$(cut -d' ' -f1 "$SUM")" ]]
}

# Downloaded files carry com.apple.quarantine, which makes Gatekeeper refuse an ad-hoc
# signed binary. Clear it only once the checksum matched. The extension's launcher does the
# same for its installed copy.
trust_helper() {
  chmod 755 "$BIN"
  xattr -d com.apple.quarantine "$BIN" 2>/dev/null || true
}

# ---------------------------------------------------------------- helper
prepare_helper() {
  if [[ -f "$MARKER" || ! -f helper/Package.swift ]] && [[ "$FORCE" != "1" ]]; then
    checksum_ok || die "The prebuilt helper ($BIN) is missing or does not match $SUM. Download the release zip again."
    trust_helper
    log "Helper: using the prebuilt $("$BIN" --version)"
    return
  fi

  local expected
  expected="$(tr -d '[:space:]' < helper/VERSION)"
  if [[ "$FORCE" != "1" ]] && checksum_ok && ! newer_than "$BIN" helper/Sources helper/Package.swift helper/VERSION; then
    trust_helper
    if [[ "$("$BIN" --version 2>/dev/null)" == "$expected" ]]; then
      log "Helper: up to date ($expected)"
      return
    fi
  fi
  command -v swift >/dev/null || die "The helper needs a build (version $expected), which needs the Xcode Command Line Tools: run xcode-select --install, or use a release zip from GitHub Releases."
  bash scripts/build-helper.sh
}

# ---------------------------------------------------------------- editor
prepare_editor() {
  if [[ -f "$MARKER" || ! -f editor/vite.config.ts ]] && [[ "$FORCE" != "1" ]]; then
    [[ -f "$EDITOR_INDEX" ]] || die "The prebuilt editor ($EDITOR_INDEX) is missing. Download the release zip again."
    log "Editor: using the prebuilt bundle"
    return
  fi
  if [[ "$FORCE" != "1" && -f "$EDITOR_INDEX" ]] &&
    ! newer_than "$EDITOR_INDEX" editor/src editor/index.html editor/vite.config.ts editor/package.json packages/core/src package-lock.json; then
    log "Editor: up to date"
    return
  fi
  log "Editor: building"
  npm run build:editor
}

prepare_editor
prepare_helper
