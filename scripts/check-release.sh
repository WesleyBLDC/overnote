#!/bin/bash
# Checks a release zip the way a person gets it: downloaded by a browser, so every file carries
# com.apple.quarantine. Headless only: it never shows the panel and never talks to Raycast.
#
#   scripts/check-release.sh <overnote-x.y.z.zip | https://.../overnote-x.y.z.zip> [options]
#
# Steps:
#   1. Downloads the zip (for a URL) and checks it against SHA256SUMS: the one next to a local
#      zip, or the one from the same release for a URL.
#   2. Marks the zip and every extracted file as downloaded by Safari (com.apple.quarantine).
#   3. Runs `npm run install-extension -- --no-register` in the extracted folder with the Xcode
#      tools, `open`, and `ray` replaced by stubs that fail and are recorded, so any use of them
#      fails the check. The prebuilt helper and editor must be used.
#   4. Quarantines the helper again, then starts it through the extracted extension's own
#      launcher (src/domain/launcher.ts, bundled with the extracted esbuild) with --headless and
#      temporary support, socket, and pid paths; pings it, creates and lists a note, shuts it down.
#   5. Checks that the launcher cleared the quarantine, that the ad-hoc signature verifies
#      (codesign --verify --strict), and reports what Gatekeeper (spctl) says before and after.
#
# Options:
#   --sums <file|url>  SHA256SUMS to check against (default: next to the zip, or from the release)
#   --no-sums          skip the checksum check (for a zip that has no SHA256SUMS)
#   --ray-build        also run `ray build` on the extracted folder (CI; needs no Raycast app)
#   --keep             keep the work directory and print where it is
set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
  exit 2
}

SOURCE=""
SUMS=""
CHECK_SUMS=1
RAY_BUILD=0
KEEP=0
while (($#)); do
  case "$1" in
    --sums)
      SUMS="${2:?--sums needs a file or URL}"
      shift
      ;;
    --no-sums) CHECK_SUMS=0 ;;
    --ray-build) RAY_BUILD=1 ;;
    --keep) KEEP=1 ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      [[ -z "$SOURCE" ]] || usage
      SOURCE="$1"
      ;;
  esac
  shift
done
[[ -n "$SOURCE" ]] || usage

log() { printf '[check-release] %s\n' "$*"; }
die() {
  printf '[check-release] FAILED: %s\n' "$*" >&2
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || die "this check runs on macOS only"

# The downloaded zip and its contents live in their own directory; the stubs and the bundled
# driver live in another, and the socket directory is short because socket paths are limited
# to 104 bytes on macOS.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/overnote-release-check.XXXXXX")"
DOWNLOAD="$WORK/download"
TOOLS="$WORK/tools"
RUNTIME="$(mktemp -d /tmp/ovrc.XXXXXX)"
mkdir -p "$DOWNLOAD" "$TOOLS"
# The helper started below never writes into the real backups folder.
export OVERNOTE_BACKUP_DIR="$WORK/backups"
cleanup() {
  local pid
  pid="$(cat "$RUNTIME"/overnote-*/helper.pid 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid" 2>/dev/null || true; fi
  rm -rf "$RUNTIME"
  if ((KEEP)); then log "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

QUARANTINE="0083;$(printf %x "$(date +%s)");Safari;"
quarantine() { xattr -w com.apple.quarantine "$QUARANTINE" "$1"; }
is_quarantined() { xattr -p com.apple.quarantine "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- 1. download and checksum
if [[ "$SOURCE" =~ ^https?:// ]]; then
  ZIP_NAME="$(basename "${SOURCE%%\?*}")"
  log "Downloading $SOURCE"
  curl -fsSL --retry 3 -o "$DOWNLOAD/$ZIP_NAME" "$SOURCE"
  [[ -n "$SUMS" ]] || SUMS="$(dirname "$SOURCE")/SHA256SUMS"
else
  [[ -f "$SOURCE" ]] || die "$SOURCE does not exist"
  ZIP_NAME="$(basename "$SOURCE")"
  cp "$SOURCE" "$DOWNLOAD/$ZIP_NAME"
  [[ -n "$SUMS" ]] || SUMS="$(cd "$(dirname "$SOURCE")" && pwd)/SHA256SUMS"
fi
ZIP="$DOWNLOAD/$ZIP_NAME"

if ((CHECK_SUMS)); then
  if [[ "$SUMS" =~ ^https?:// ]]; then
    curl -fsSL --retry 3 -o "$TOOLS/SHA256SUMS" "$SUMS" || die "could not download $SUMS (pass --no-sums to skip)"
  else
    [[ -f "$SUMS" ]] || die "$SUMS does not exist (pass --sums or --no-sums)"
    cp "$SUMS" "$TOOLS/SHA256SUMS"
  fi
  expected="$(awk -v name="$ZIP_NAME" '$2 == name || $2 == "*" name { print $1 }' "$TOOLS/SHA256SUMS")"
  [[ -n "$expected" ]] || die "SHA256SUMS has no line for $ZIP_NAME"
  actual="$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
  [[ "$actual" == "$expected" ]] || die "$ZIP_NAME is $actual, SHA256SUMS says $expected"
  log "Checksum: $ZIP_NAME matches SHA256SUMS ($actual)"
else
  log "Checksum: skipped (--no-sums)"
fi

# ---------------------------------------------------------------- 2. a browser download
quarantine "$ZIP"
(cd "$DOWNLOAD" && unzip -q "$ZIP_NAME")
PKG="$DOWNLOAD/overnote"
[[ -f "$PKG/package.json" ]] || die "the zip has no overnote/ folder"
[[ ! -d "$PKG/helper" ]] || die "the zip should not carry helper sources"
[[ -f "$PKG/assets/prebuilt.json" ]] || die "the zip has no assets/prebuilt.json"
while IFS= read -r -d '' file; do quarantine "$file"; done < <(find "$PKG" -print0)
BIN="$PKG/assets/bin/OvernoteHelper"
is_quarantined "$BIN" || die "could not quarantine $BIN"
HELPER_VERSION="$(node -p 'require(process.argv[1]).helperVersion' "$PKG/assets/prebuilt.json")"
log "Quarantined the zip and $(find "$PKG" | wc -l | tr -d ' ') extracted paths"

gatekeeper() {
  local out status=0
  out="$(spctl --assess --type execute -vv "$BIN" 2>&1)" || status=$?
  log "Gatekeeper ($1): spctl exit $status: ${out//$'\n'/ | }"
}
signature() {
  codesign --verify --strict -vv "$BIN" 2>&1 | sed "s|^|[check-release]   |" || die "the helper signature does not verify ($1)"
  log "Signature ($1): codesign --verify --strict passed"
}
log "spctl status: $(spctl --status 2>&1 || true)"
gatekeeper "quarantined"
signature "quarantined"

# ---------------------------------------------------------------- 3. install without Xcode or Raycast
STUBS="$TOOLS/stubs"
mkdir -p "$STUBS"
for tool in swift swiftc xcrun xcodebuild xcode-select clang clang++ cc gcc make lipo open ray osascript; do
  cat >"$STUBS/$tool" <<EOF
#!/bin/bash
echo "$tool \$*" >> "$TOOLS/stub-calls.log"
echo "check-release: $tool is not allowed during install" >&2
exit 97
EOF
  chmod 755 "$STUBS/$tool"
done
log "Installing: npm run install-extension -- --no-register"
INSTALL_LOG="$TOOLS/install.log"
if ! (cd "$PKG" && PATH="$STUBS:$PATH" npm_config_strict_allow_scripts=true npm run install-extension -- --no-register) >"$INSTALL_LOG" 2>&1; then
  cat "$INSTALL_LOG" >&2
  die "install-extension failed"
fi
sed 's/^/[check-release]   /' "$INSTALL_LOG"
if [[ -s "$TOOLS/stub-calls.log" ]]; then
  cat "$TOOLS/stub-calls.log" >&2
  die "the install used tools it must not need (above)"
fi
grep -q "Helper: using the prebuilt $HELPER_VERSION" "$INSTALL_LOG" || die "the install did not use the prebuilt helper $HELPER_VERSION"
grep -q "Editor: using the prebuilt bundle" "$INSTALL_LOG" || die "the install did not use the prebuilt editor"
[[ -f "$PKG/assets/editor/index.html" ]] || die "the prebuilt editor is missing"
log "Install: used the prebuilt helper ($HELPER_VERSION) and editor, with no Xcode tools and no Raycast"

# ---------------------------------------------------------------- 4. the launcher, headless
# prepare-assets.sh clears the quarantine after its checksum check; put it back so this step
# shows that the launcher clears it on its own too (a copy the install script never touched).
quarantine "$BIN"
is_quarantined "$BIN" || die "could not quarantine $BIN again"

cat >"$TOOLS/driver.ts" <<EOF
import fs from "node:fs";
import path from "node:path";

import { contentFromMarkdown } from "$PKG/src/api/content";
import { HelperLauncher } from "$PKG/src/domain/launcher";
import { resolvePaths } from "$PKG/src/domain/paths";
import { isProcessAlive, waitForExit } from "$PKG/src/domain/process";
import { RpcClient } from "$PKG/src/domain/rpc-client";

const [assets, support, runtimeRoot, expected] = process.argv.slice(2) as [string, string, string, string];
const fail = (message: string): never => {
  console.error("[check-release] FAILED: " + message);
  process.exit(1);
};

const paths = resolvePaths({ supportPath: support, assetsPath: assets, runtimeRoot });
const launcher = new HelperLauncher({ paths, client: new RpcClient({ socketPath: paths.socket }), readyTimeoutMs: 10000 });
const started = await launcher.ensure({ headless: true });
if (!started.started) fail("the launcher reused a helper that was already running");
if (started.version !== expected) fail("the helper reports " + started.version + ", expected " + expected);
console.log("[check-release] Launcher: started the helper " + started.version + " (pid " + started.pid + ") headless");

const ping = await launcher.ping();
if (!ping || ping.pid !== started.pid) fail("system.ping did not answer from the started helper");
console.log("[check-release] Ping: " + JSON.stringify(ping));

const marker = "Release check " + Date.now();
const created = await started.client.call("notes.create", contentFromMarkdown("# " + marker + "\n\nWritten by scripts/check-release.sh"));
const listed = await started.client.call("notes.list", {});
const found = listed.items.find((note) => note.id === created.id);
if (!found) fail("notes.list does not include the created note " + created.id);
if (found.title !== marker) fail("the created note is titled " + JSON.stringify(found.title) + ", expected " + JSON.stringify(marker));
console.log("[check-release] Notes: created " + created.id + " and listed " + listed.items.length + " note(s), title " + JSON.stringify(found.title));
if (!fs.existsSync(path.join(support, "notes.sqlite"))) fail("the database was not created in the support dir");

await launcher.stop(started.pid);
if (!(await waitForExit(started.pid, 5000)) || isProcessAlive(started.pid)) fail("the helper is still running after shutdown");
if (fs.existsSync(paths.pidFile)) fail("the pid file is still there after shutdown");
launcher.client.close();
console.log("[check-release] Shutdown: the helper exited and its pid file is gone");
EOF
"$PKG/node_modules/.bin/esbuild" "$TOOLS/driver.ts" --bundle --platform=node --format=esm --target=node22 \
  --log-level=warning --outfile="$TOOLS/driver.mjs"
node "$TOOLS/driver.mjs" "$PKG/assets" "$WORK/support" "$RUNTIME" "$HELPER_VERSION"

# ---------------------------------------------------------------- 5. quarantine, signature, Gatekeeper
if is_quarantined "$BIN"; then die "the launcher left com.apple.quarantine on the helper"; fi
log "Quarantine: the launcher cleared com.apple.quarantine from the helper"
signature "after launch"
gatekeeper "quarantine cleared"

if ((RAY_BUILD)); then
  log "Building the extracted extension (ray build)"
  (cd "$PKG" && npx ray build -e dist -o "$WORK/raybuild")
  [[ -x "$WORK/raybuild/assets/bin/OvernoteHelper" ]] || die "ray build did not ship an executable helper"
  log "ray build: the build ships an executable helper"
fi

log "All checks passed for $ZIP_NAME"
