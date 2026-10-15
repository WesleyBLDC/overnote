#!/bin/bash
# Builds the universal (arm64 + x86_64) OvernoteHelper with only the Xcode Command Line
# Tools, ad-hoc signs it, and installs it to assets/bin with a .sha256 file.
#
# `swift build --arch arm64 --arch x86_64` needs XCBuild, which ships only with full Xcode,
# so each architecture is built separately and merged with lipo.
#
# Rerunning is cheap: SwiftPM builds incrementally, and the copy, signature, and checksum
# are skipped when the installed binary already matches the fresh build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE="$ROOT/helper"
OUT_DIR="$ROOT/assets/bin"
OUT="$OUT_DIR/OvernoteHelper"
PRODUCT=OvernoteHelper
MIN_MACOS=14.0
ARCHES=(arm64 x86_64)

log() { printf '[build-helper] %s\n' "$*"; }

command -v swift >/dev/null || { echo "swift not found: install the Xcode Command Line Tools (xcode-select --install)" >&2; exit 1; }

slices=()
for arch in "${ARCHES[@]}"; do
  triple="$arch-apple-macosx$MIN_MACOS"
  log "Building $arch"
  swift build --package-path "$PACKAGE" -c release --triple "$triple" --product "$PRODUCT" >/dev/null
  bin_dir="$(swift build --package-path "$PACKAGE" -c release --triple "$triple" --show-bin-path)"
  slices+=("$bin_dir/$PRODUCT")
done

STAGING="$PACKAGE/.build/universal"
mkdir -p "$STAGING" "$OUT_DIR"
log "Merging slices with lipo"
lipo -create "${slices[@]}" -output "$STAGING/$PRODUCT.unsigned"

# Compare the unsigned universal binary with the one we signed last time. If nothing
# changed, keep the installed, already signed binary as it is.
if [[ -f "$OUT" && -f "$STAGING/$PRODUCT.unsigned.last" ]] && cmp -s "$STAGING/$PRODUCT.unsigned" "$STAGING/$PRODUCT.unsigned.last" \
   && codesign --verify --strict "$OUT" 2>/dev/null; then
  log "Up to date: $OUT"
else
  cp "$STAGING/$PRODUCT.unsigned" "$STAGING/$PRODUCT"
  log "Signing ad-hoc with the hardened runtime"
  # The hardened runtime does not stop WKWebView: JavaScript JIT runs in WebKit's own
  # WebContent process, which carries its own entitlements.
  codesign --force --sign - --options runtime --identifier "dev.overnote.helper" "$STAGING/$PRODUCT"
  codesign --verify --strict "$STAGING/$PRODUCT"
  # Install atomically so a running helper's binary is never half written.
  cp "$STAGING/$PRODUCT" "$OUT.tmp"
  mv -f "$OUT.tmp" "$OUT"
  cp "$STAGING/$PRODUCT.unsigned" "$STAGING/$PRODUCT.unsigned.last"
fi

codesign --verify --strict "$OUT"
BUILT_VERSION="$("$OUT" --version)"
EXPECTED_VERSION="$(tr -d '[:space:]' < "$PACKAGE/VERSION")"
if [[ "$BUILT_VERSION" != "$EXPECTED_VERSION" ]]; then
  echo "Version mismatch: helper/VERSION says $EXPECTED_VERSION but the binary reports $BUILT_VERSION (HelperVersion.current)" >&2
  exit 1
fi
(cd "$OUT_DIR" && shasum -a 256 "$PRODUCT" > "$PRODUCT.sha256")
log "Architectures: $(lipo -archs "$OUT")"
log "Version: $BUILT_VERSION"
log "SHA-256: $(cut -d' ' -f1 "$OUT.sha256")"
