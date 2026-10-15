#!/bin/bash
# Runs Overnote in Raycast from this checkout, with every change live:
#
#   npm run dev
#
# - The extension (src/) runs in Raycast development mode (`ray develop`), rebuilt on every save.
# - The editor is rebuilt on every save (`vite build --watch`), and the open panel saves the note
#   and reloads with the new build within about a second (the helper's --watch-editor).
# - The helper is rebuilt when its Swift sources change; the next Raycast command restarts it.
#
# The panel uses the checkout's assets/ directly, through assets/dev.json, which only a
# development build reads (src/domain/paths.ts). Your real notes are used, as in any install.
# Stop with ⌃C; Raycast keeps the extension installed, still running this checkout's last build.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
HELPER_POLL_SECONDS=2

log() { printf '[dev] %s\n' "$*"; }

bash scripts/prepare-assets.sh
node -e 'require("fs").writeFileSync("assets/dev.json", JSON.stringify({ assetsDir: process.argv[1] }, null, 2) + "\n")' "$ROOT/assets"

pids=()
cleanup() {
  for pid in "${pids[@]}"; do
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

# The editor: Vite writes assets/editor/index.html last, which the helper watches.
(npm run build -w editor -- --watch --logLevel warn 2>&1 | sed -u 's/^/[editor] /') &
pids+=($!)

# The helper: rebuilt when anything under helper/ that goes into the binary changes.
helper_fingerprint() {
  find helper/Sources helper/Package.swift helper/VERSION -type f -exec stat -f '%m %N' {} + 2>/dev/null | sort | shasum | cut -d' ' -f1
}
(
  last="$(helper_fingerprint)"
  while sleep "$HELPER_POLL_SECONDS"; do
    now="$(helper_fingerprint)"
    [[ "$now" == "$last" ]] && continue
    last="$now"
    log "Helper sources changed; rebuilding"
    if bash scripts/build-helper.sh >/dev/null 2>&1; then
      log "Helper rebuilt; the next Raycast command restarts it"
    else
      log "Helper build failed; run npm run build:helper to see why"
    fi
  done
) &
pids+=($!)

log "Editor and helper watchers running; starting ray develop"
node_modules/.bin/ray develop "$@"
