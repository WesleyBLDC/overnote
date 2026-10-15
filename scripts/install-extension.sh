#!/bin/bash
# Installs Overnote into your Raycast from this folder: a release zip or a git checkout.
#
#   npm run install-extension
#
# 1. Checks for macOS, Node 22+, and Raycast.
# 2. Installs dependencies with `npm ci` when node_modules is missing or out of date.
# 3. Prepares the helper and the editor (scripts/prepare-assets.sh): a release zip uses its
#    prebuilt, checksummed assets, so only Node and Raycast are needed.
# 4. Runs `ray develop` until the extension is built and Raycast has been told about it,
#    then stops it. Raycast keeps a development extension listed after `ray develop` exits,
#    so this is a one time step. (`ray build` alone only refreshes an extension Raycast
#    already knows, so it cannot do the first install.)
#
# Options:
#   --no-register  stop after step 3 (useful to check a release zip without touching Raycast)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
REGISTER=1
[[ "${1:-}" == "--no-register" ]] && REGISTER=0
EXTENSION_NAME="$(node -p 'require("./package.json").name' 2>/dev/null || echo overnote)"
BUILD_DIR="$HOME/.config/raycast/extensions/$EXTENSION_NAME"
DEVELOP_TIMEOUT=180

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. requirements
[[ "$(uname -s)" == "Darwin" ]] || die "Overnote runs on macOS only."
macos_major="$(sw_vers -productVersion | cut -d. -f1)"
(( macos_major >= 14 )) || die "Overnote needs macOS 14 Sonoma or later (this Mac runs $(sw_vers -productVersion))."
command -v node >/dev/null || die "Node.js 22 or later is required: https://nodejs.org"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 22 )) || die "Node.js 22 or later is required (found $(node --version))."
if (( REGISTER )); then
  open -Ra Raycast 2>/dev/null || die "Raycast is not installed: https://www.raycast.com"
fi

# ---------------------------------------------------------------- 2. dependencies
# npm ci rewrites node_modules/.package-lock.json, so it is newer than the lockfile after a
# successful install.
if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
  log "Installing dependencies (npm ci)"
  npm ci --no-audit --no-fund
else
  log "Dependencies: up to date"
fi

# ---------------------------------------------------------------- 3. assets
bash scripts/prepare-assets.sh
# Records this folder for Check for Updates, which runs from Raycast's copy of the build and
# shows the update command for the folder the person installed from.
node -e 'require("fs").writeFileSync("assets/install-location.json", JSON.stringify({ installDir: process.argv[1] }, null, 2) + "\n")' "$ROOT"

if (( ! REGISTER )); then
  log "Ready. Skipped registering with Raycast (--no-register)."
  exit 0
fi

# ---------------------------------------------------------------- 4. register with Raycast
if ! pgrep -xq Raycast; then
  log "Starting Raycast"
  open -g -a Raycast
  for _ in $(seq 1 60); do pgrep -xq Raycast && break; sleep 0.5; done
  pgrep -xq Raycast || die "Raycast did not start."
fi
LOG="$(mktemp -t overnote-develop)"
log "Registering with Raycast (ray develop)"
# Run the ray binary directly, not through npm, so the interrupt below reaches it and it can
# tell Raycast that the development session ended.
node_modules/.bin/ray develop --non-interactive >"$LOG" 2>&1 &
DEVELOP_PID=$!
stop_develop() {
  if kill -0 "$DEVELOP_PID" 2>/dev/null; then
    kill -INT "$DEVELOP_PID" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$DEVELOP_PID" 2>/dev/null || break; sleep 0.1; done
    kill -TERM "$DEVELOP_PID" 2>/dev/null || true
  fi
}
trap 'stop_develop; rm -f "$LOG"' EXIT

built=0
for _ in $(seq 1 $((DEVELOP_TIMEOUT * 4))); do
  if grep -q "built extension successfully" "$LOG"; then built=1; break; fi
  kill -0 "$DEVELOP_PID" 2>/dev/null || break
  sleep 0.25
done
if (( ! built )); then
  cat "$LOG" >&2
  die "ray develop did not finish building within ${DEVELOP_TIMEOUT} s (output above)."
fi
# Give Raycast a moment to load the fresh build before the session ends.
sleep 3
stop_develop

[[ -f "$BUILD_DIR/package.json" ]] || die "The build is missing from $BUILD_DIR."
log "Installed into Raycast ($BUILD_DIR)."
cat <<'EOF'

Next:
  1. Open Raycast Settings, go to Extensions, and find Toggle Overnote.
  2. Record a hotkey for it (Overnote ships without one; ⌥N works well).
  3. Press your hotkey to open the panel.

To update later, run `npm run update-extension` in this folder (Check for Updates in Raycast
tells you when a new release is out). Your notes are backed up before every update.
EOF
