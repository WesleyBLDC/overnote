#!/bin/bash
# Builds Overnote.app: the same OvernoteHelper binary and editor build the Raycast extension
# ships, packaged as a menu bar app with its own hotkey (docs/architecture.md section 1).
#
#   npm run build:app      builds dist-app/Overnote.app
#   npm run app:install    builds it, then copies it to /Applications
#
# The editor and helper builds come from scripts/prepare-assets.sh (which reuses or rebuilds
# assets/editor and assets/bin/OvernoteHelper), so this script only assembles and signs:
#   Contents/MacOS/Overnote        the helper binary, which runs in app mode from this bundle
#   Contents/Resources/editor/     the built editor
#   Contents/Resources/Overnote.icns  made from assets/brand/overnote-logo-1024.png with sips and
#                                     iconutil, every size from 16 to 512@2x (1024 px)
#   Contents/Info.plist            com.wesleybldc.overnote, version from helper/VERSION
# The bundle is signed ad hoc (codesign --sign -) for this Mac only: no Developer ID, no
# notarization.
#
# Options:
#   --install   copy the built app to /Applications (refuses while Overnote.app is running)
#   --no-prepare  use assets/ as it is, without running prepare-assets.sh (for verify, which
#                 has just built both)
#   --check     after building, start the bundle's binary headless with temporary folders and
#               check that it runs in app mode (system.ping reports host "app"); no window opens
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT_DIR="$ROOT/dist-app"
APP="$OUT_DIR/Overnote.app"
INSTALL_DIR="${OVERNOTE_APP_INSTALL_DIR:-/Applications}"
BUNDLE_ID="com.wesleybldc.overnote"
MIN_MACOS="14.0"

log() { printf '[build-app] %s\n' "$*"; }
die() {
  printf '[build-app] %s\n' "$*" >&2
  exit 1
}

INSTALL=0
PREPARE=1
CHECK=0
while (($#)); do
  case "$1" in
    --install) INSTALL=1 ;;
    --no-prepare) PREPARE=0 ;;
    --check) CHECK=1 ;;
    *) die "Unknown option $1 (expected --install, --no-prepare, or --check)" ;;
  esac
  shift
done

for tool in sips iconutil codesign plutil ditto; do
  command -v "$tool" >/dev/null || die "$tool is required (it ships with macOS)."
done

((PREPARE)) && bash scripts/prepare-assets.sh
BIN="assets/bin/OvernoteHelper"
[[ -x "$BIN" ]] || die "$BIN is missing: run npm run build:helper first."
[[ -f assets/editor/index.html ]] || die "assets/editor is missing: run npm run build:editor first."
VERSION="$(tr -d '[:space:]' <helper/VERSION)"

# Assemble next to the target and swap it in, so a failed build never leaves half an app.
STAGE="$OUT_DIR/.Overnote.app.partial"
ICONSET="$OUT_DIR/.Overnote.iconset"
rm -rf "$STAGE" "$ICONSET"
trap 'rm -rf "$STAGE" "$ICONSET"' EXIT
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources" "$ICONSET"

cp "$BIN" "$STAGE/Contents/MacOS/Overnote"
chmod 755 "$STAGE/Contents/MacOS/Overnote"
ditto assets/editor "$STAGE/Contents/Resources/editor"

ICON_SRC="assets/brand/overnote-logo-1024.png"
[[ -f "$ICON_SRC" ]] || die "$ICON_SRC is missing: it is the 1024 px logo master the app icon is made from."
[[ "$(sips -g pixelWidth "$ICON_SRC" | awk '/pixelWidth/ {print $2}')" == 1024 ]] || die "$ICON_SRC must be 1024 px wide."
log "Icon: Overnote.icns from $ICON_SRC"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  # The source is 1024 px, so the 512@2x slot is the source itself.
  if ((double < 1024)); then
    sips -z "$double" "$double" "$ICON_SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  else
    cp "$ICON_SRC" "$ICONSET/icon_${size}x${size}@2x.png"
  fi
done
iconutil -c icns "$ICONSET" -o "$STAGE/Contents/Resources/Overnote.icns"
# Menu bar template (one colour, alpha only), made from the master by scripts/make-menubar-icon.swift.
cp assets/brand/menubar/OvernoteStatusTemplate.png assets/brand/menubar/OvernoteStatusTemplate@2x.png "$STAGE/Contents/Resources/"

cat >"$STAGE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Overnote</string>
  <key>CFBundleDisplayName</key><string>Overnote</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>Overnote</string>
  <key>CFBundleIconFile</key><string>Overnote</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_MACOS</string>
  <key>LSUIElement</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT License</string>
</dict>
</plist>
EOF
plutil -lint "$STAGE/Contents/Info.plist" >/dev/null || die "Info.plist does not parse"

log "Signing ad hoc with the hardened runtime"
codesign --force --sign - --options runtime "$STAGE"
codesign --verify --strict "$STAGE" || die "The bundle signature does not verify"

rm -rf "$APP"
mv "$STAGE" "$APP"
codesign --verify --strict "$APP" || die "The bundle signature does not verify after the move"
BUILT="$("$APP/Contents/MacOS/Overnote" --version)"
[[ "$BUILT" == "$VERSION" ]] || die "The app's binary reports $BUILT, but helper/VERSION says $VERSION"
log "Built $APP (version $BUILT, $(lipo -archs "$APP/Contents/MacOS/Overnote"))"

if ((CHECK)); then
  # Short, because socket paths are limited to 104 bytes on macOS.
  CHECK_DIR="$(mktemp -d /tmp/ovapp.XXXXXX)"
  trap 'rm -rf "$STAGE" "$ICONSET" "$CHECK_DIR"' EXIT
  # No --app: the bundle identifier alone must turn app mode on.
  OVERNOTE_BACKUP_DIR="$CHECK_DIR/backups" "$APP/Contents/MacOS/Overnote" --headless --support-dir "$CHECK_DIR/support" \
    --socket "$CHECK_DIR/run/helper.sock" --pid-file "$CHECK_DIR/run/helper.pid" >"$CHECK_DIR/stdout.log" 2>&1 &
  check_pid=$!
  host="$(node -e '
    const net = require("node:net");
    const [socket, pid] = process.argv.slice(1);
    const deadline = Date.now() + 15000;
    const attempt = () => {
      const s = net.createConnection(socket);
      s.setEncoding("utf8");
      let buffer = "";
      s.on("data", (chunk) => {
        buffer += chunk;
        if (!buffer.includes("\n")) return;
        const reply = JSON.parse(buffer.split("\n")[0]).result;
        if (String(reply.pid) !== pid) return retry();
        s.end(JSON.stringify({ id: 2, method: "system.shutdown" }) + "\n");
        process.stdout.write(reply.host, () => process.exit(0));
      });
      s.on("error", retry);
      s.write(JSON.stringify({ id: 1, method: "system.ping" }) + "\n");
    };
    const retry = () => (Date.now() > deadline ? process.exit(1) : setTimeout(attempt, 50));
    attempt();' "$CHECK_DIR/run/helper.sock" "$check_pid")" || {
    kill -KILL "$check_pid" 2>/dev/null || true
    cat "$CHECK_DIR/stdout.log" >&2
    die "The app's binary did not answer on its socket"
  }
  for _ in $(seq 1 100); do
    kill -0 "$check_pid" 2>/dev/null || break
    sleep 0.05
  done
  if kill -0 "$check_pid" 2>/dev/null; then
    kill -KILL "$check_pid"
    die "The app's binary did not exit after system.shutdown"
  fi
  [[ "$host" == "app" ]] || die "The app's binary runs as host \"$host\", expected \"app\""
  log "Check: the bundle runs in app mode (system.ping host app), headless, and shuts down cleanly"
fi

((INSTALL)) || exit 0

TARGET="$INSTALL_DIR/Overnote.app"
# Only a read: never stop the app for the person, since its panel may hold an unsaved edit.
if pgrep -f "^$TARGET/Contents/MacOS/Overnote" >/dev/null 2>&1; then
  die "Overnote.app is running. Quit it first (menu bar item, Quit Overnote), then run npm run app:install again."
fi
log "Installing to $TARGET"
NEXT="$INSTALL_DIR/.Overnote.app.installing"
rm -rf "$NEXT"
ditto "$APP" "$NEXT"
rm -rf "$TARGET"
mv "$NEXT" "$TARGET"
codesign --verify --strict "$TARGET" || die "The installed app's signature does not verify"
log "Installed. Open it with: open '$TARGET'"
