#!/bin/bash
# Updates an installed Overnote release, in place, to the latest GitHub release or a chosen one.
# Run it inside the folder you installed from (the unzipped release):
#
#   npm run update-extension                       the latest release
#   npm run update-extension -- --version v0.3.0   a specific release (also to roll back)
#
# Steps:
#   1. Reads the installed version from assets/prebuilt.json (only a release install has one).
#   2. Asks the GitHub releases API for the target release, downloads its zip and SHA256SUMS to a
#      temporary folder, and checks the zip against SHA256SUMS.
#   3. Rollback guard: refuses a release whose helper writes an older database schema than the
#      one your notes already use (PRAGMA user_version, read with sqlite3 -readonly on a copy).
#   4. Backs up your notes: asks the running helper for system.backup {reason: "pre-update"},
#      starting it headless first when it is not running. If the helper cannot start, it copies
#      the database with `sqlite3 .backup` instead.
#   5. Stops the helper cleanly (system.shutdown, then SIGTERM through its pid file).
#   6. Replaces this folder's files with the release's, keeping node_modules. It never touches
#      the notes (the extension's support folder) or the backups folder.
#   7. Runs scripts/install-extension.sh from the new files and prints the old and new versions.
#
# Options:
#   --version vX.Y.Z  update or roll back to that release instead of the latest
#   --force           reinstall even when the target is the installed version
#   --no-register     passed on to install-extension.sh (skips Raycast; for tests)
#
# Environment (the end-to-end test points every one of these at temporary folders):
#   OVERNOTE_RELEASES_API  releases API base, default https://api.github.com/repos/WesleyBLDC/overnote/releases
#   OVERNOTE_SUPPORT_DIR   the extension's support folder (environment.supportPath), default
#                          ~/Library/Application Support/com.raycast.macos/extensions/<name>
#   OVERNOTE_RUNTIME_DIR   the helper's socket and pid folder, default /tmp/overnote-<uid>
#   OVERNOTE_BACKUP_DIR    the backups folder, default ~/Library/Application Support/Overnote/backups
set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
  exit 2
}

log() { printf '[update] %s\n' "$*"; }
die() {
  printf '[update] %s\n' "$*" >&2
  exit 1
}

# Reads one field of a JSON file: json_field <file> <field> [default]
json_field() {
  node -e '
    const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
    process.stdout.write(value === undefined || value === null ? (process.argv[3] ?? "") : String(value));' "$@"
}

# Semver precedence of $1 against $2: prints -1, 0, or 1.
semver_cmp() {
  node -e '
    const parse = (t) => {
      const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(t);
      if (!m) { console.error("Not a version: " + t); process.exit(2); }
      return { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split(".") : [] };
    };
    const [a, b] = [parse(process.argv[1]), parse(process.argv[2])];
    const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);
    const cmp = () => {
      for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
      if (!a.pre.length || !b.pre.length) return b.pre.length - a.pre.length;
      for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
        const [x, y] = [a.pre[i], b.pre[i]];
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
        if (x === y) continue;
        const [xn, yn] = [/^\d+$/.test(x), /^\d+$/.test(y)];
        if (xn && yn) return +x - +y;
        if (xn !== yn) return xn ? -1 : 1;
        return x < y ? -1 : 1;
      }
      return 0;
    };
    console.log(sign(cmp()));' "$1" "$2"
}

# Sends one request to the helper and prints its result as JSON: rpc <method> [params] [timeout s].
# Exits 1 when nothing answers, 2 when the helper answers with an error (printed to stderr).
rpc() {
  local params="${2:-}"
  [[ -n "$params" ]] || params='{}'
  node -e '
    const [socket, method, params, timeout] = process.argv.slice(1);
    const s = require("node:net").createConnection(socket);
    let buffer = "";
    s.setEncoding("utf8");
    s.on("data", (chunk) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end === -1) return;
      const reply = JSON.parse(buffer.slice(0, end));
      if (reply.error) { console.error(reply.error.message); process.exit(2); }
      process.stdout.write(JSON.stringify(reply.result), () => process.exit(0));
    });
    s.on("error", () => process.exit(1));
    s.write(JSON.stringify({ id: 1, method, params: JSON.parse(params) }) + "\n");
    setTimeout(() => process.exit(1), Number(timeout) * 1000);' "$SOCKET" "$1" "$params" "${3:-3}"
}

is_helper_pid() {
  [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null && [[ "$(ps -p "$1" -o comm= 2>/dev/null)" == *OvernoteHelper ]]
}

main() {
  local ROOT
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  cd "$ROOT"

  local TARGET_TAG="" FORCE=0 INSTALL_ARGS=()
  while (($#)); do
    case "$1" in
      --version)
        TARGET_TAG="${2:?--version needs a release, for example v0.3.0}"
        [[ "$TARGET_TAG" == v* ]] || TARGET_TAG="v$TARGET_TAG"
        shift
        ;;
      --force) FORCE=1 ;;
      --no-register) INSTALL_ARGS+=(--no-register) ;;
      -h | --help) usage ;;
      *) usage ;;
    esac
    shift
  done

  # ------------------------------------------------------------ 1. the installed release
  [[ -f assets/prebuilt.json && ! -d .git ]] ||
    die "This folder is not an installed release (no assets/prebuilt.json). In a git checkout, use git pull and npm run install-extension."
  for tool in node curl unzip rsync sqlite3 shasum; do
    command -v "$tool" >/dev/null || die "$tool is required."
  done
  local CURRENT NAME
  CURRENT="$(json_field assets/prebuilt.json version)"
  [[ -n "$CURRENT" ]] || die "assets/prebuilt.json has no version."
  NAME="$(json_field package.json name overnote)"

  local API="${OVERNOTE_RELEASES_API:-https://api.github.com/repos/WesleyBLDC/overnote/releases}"
  local SUPPORT="${OVERNOTE_SUPPORT_DIR:-$HOME/Library/Application Support/com.raycast.macos/extensions/$NAME}"
  local RUNTIME="${OVERNOTE_RUNTIME_DIR:-/tmp/overnote-$(id -u)}"
  SOCKET="$RUNTIME/helper.sock"
  local PIDFILE="$RUNTIME/helper.pid"
  local BACKUP_DIR="${OVERNOTE_BACKUP_DIR:-$HOME/Library/Application Support/Overnote/backups}"
  local DB="$SUPPORT/notes.sqlite"
  # A helper this script starts writes to the same backups folder.
  export OVERNOTE_BACKUP_DIR="$BACKUP_DIR"
  local dir
  for dir in "$SUPPORT" "$BACKUP_DIR"; do
    [[ "$dir/" != "$ROOT/"* ]] || die "$dir is inside the install folder, which the update replaces. Move it first."
  done
  log "Installed: Overnote $CURRENT in $ROOT"

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/overnote-update.XXXXXX")"
  STARTED_PID=""
  trap 'cleanup' EXIT

  # ------------------------------------------------------------ 2. the target release
  local url release
  if [[ -n "$TARGET_TAG" ]]; then url="$API/tags/$TARGET_TAG"; else url="$API/latest"; fi
  release="$(curl -fsSL --max-time 30 --retry 2 -H 'Accept: application/vnd.github+json' -H 'User-Agent: overnote-update' "$url")" ||
    die "Could not read the release from $url"
  local TAG TARGET ZIP_URL SUMS_URL
  read -r TAG ZIP_URL SUMS_URL < <(node -e '
    const release = JSON.parse(process.argv[1]);
    const tag = String(release.tag_name ?? "");
    const version = tag.replace(/^v/, "");
    const url = (name) => (release.assets ?? []).find((asset) => asset.name === name)?.browser_download_url ?? "-";
    console.log([tag || "-", url("overnote-" + version + ".zip"), url("SHA256SUMS")].join(" "));' "$release")
  [[ -n "${TAG:-}" && "$TAG" != "-" ]] || die "The release at $url has no tag."
  TARGET="${TAG#v}"
  [[ "$ZIP_URL" != "-" && "$SUMS_URL" != "-" ]] || die "Release $TAG has no overnote-$TARGET.zip or SHA256SUMS."

  local order
  order="$(semver_cmp "$TARGET" "$CURRENT")" || die "Cannot compare the versions $TARGET and $CURRENT."
  if [[ "$order" == "0" && "$FORCE" == "0" ]]; then
    log "Overnote $CURRENT is already installed. Nothing to do (pass --force to reinstall)."
    exit 0
  fi
  if [[ "$order" == "-1" && -z "$TARGET_TAG" ]]; then
    log "The installed $CURRENT is newer than the latest release $TARGET. Nothing to do."
    exit 0
  fi
  if [[ "$order" == "-1" ]]; then log "Target: Overnote $TARGET (a rollback from $CURRENT)"; else log "Target: Overnote $TARGET"; fi

  local DOWNLOAD="$WORK/download" EXTRACT="$WORK/extract"
  mkdir -p "$DOWNLOAD" "$EXTRACT"
  local ZIP_NAME="overnote-$TARGET.zip"
  log "Downloading $ZIP_NAME"
  curl -fsSL --max-time 300 --retry 2 -o "$DOWNLOAD/$ZIP_NAME" "$ZIP_URL" || die "Could not download $ZIP_URL"
  curl -fsSL --max-time 60 --retry 2 -o "$DOWNLOAD/SHA256SUMS" "$SUMS_URL" || die "Could not download $SUMS_URL"
  local expected actual
  expected="$(awk -v name="$ZIP_NAME" '$2 == name || $2 == "*" name { print $1 }' "$DOWNLOAD/SHA256SUMS")"
  [[ -n "$expected" ]] || die "SHA256SUMS has no line for $ZIP_NAME."
  actual="$(shasum -a 256 "$DOWNLOAD/$ZIP_NAME" | cut -d' ' -f1)"
  [[ "$actual" == "$expected" ]] || die "$ZIP_NAME does not match SHA256SUMS ($actual, expected $expected). Nothing was changed."
  log "Checksum: $ZIP_NAME matches SHA256SUMS"
  unzip -q "$DOWNLOAD/$ZIP_NAME" -d "$EXTRACT"
  local NEW="$EXTRACT/overnote"
  [[ -f "$NEW/package.json" && -f "$NEW/assets/prebuilt.json" && -f "$NEW/scripts/install-extension.sh" ]] ||
    die "$ZIP_NAME is not an Overnote release."
  [[ "$(json_field "$NEW/assets/prebuilt.json" version)" == "$TARGET" ]] ||
    die "$ZIP_NAME says it is version $(json_field "$NEW/assets/prebuilt.json" version), not $TARGET."
  # Releases before schemaVersion was recorded all wrote schema 1.
  local TARGET_SCHEMA
  TARGET_SCHEMA="$(json_field "$NEW/assets/prebuilt.json" schemaVersion 1)"
  [[ "$TARGET_SCHEMA" =~ ^[0-9]+$ ]] || die "$ZIP_NAME records an invalid schemaVersion: $TARGET_SCHEMA"

  # ------------------------------------------------------------ 3. rollback guard
  local DB_SCHEMA=0
  if [[ -f "$DB" ]]; then
    mkdir -p "$WORK/schema"
    local suffix
    for suffix in "" -wal -shm; do
      [[ -f "$DB$suffix" ]] && cp "$DB$suffix" "$WORK/schema/notes.sqlite$suffix"
    done
    DB_SCHEMA="$(sqlite3 -readonly "$WORK/schema/notes.sqlite" 'PRAGMA user_version')" || die "Could not read the schema version of $DB."
    if ((TARGET_SCHEMA < DB_SCHEMA)); then
      die "Refusing to install $TARGET: its helper writes database schema $TARGET_SCHEMA, but your notes already use schema $DB_SCHEMA. A database is never downgraded, so pick a release with schema $DB_SCHEMA or newer. Nothing was changed."
    fi
    log "Database: schema $DB_SCHEMA, the target writes schema $TARGET_SCHEMA"
  else
    log "Database: none yet in $SUPPORT"
  fi

  # ------------------------------------------------------------ 4. back up the notes
  local BIN="$ROOT/assets/bin/OvernoteHelper" BACKUP_PATH=""
  if [[ -f "$DB" ]]; then
    if ! rpc system.ping >/dev/null 2>&1; then
      start_helper "$BIN" "$SUPPORT" "$RUNTIME" "$PIDFILE" "$ROOT/assets/editor" || true
    fi
    local result
    if result="$(rpc system.backup '{"reason":"pre-update"}' 120)"; then
      BACKUP_PATH="$(node -p 'JSON.parse(process.argv[1]).path' "$result")"
    else
      log "The helper could not back up the notes; copying the database with sqlite3 instead"
      BACKUP_PATH="$(sqlite_backup "$DB" "$BACKUP_DIR" "$CURRENT")" || die "Could not back up $DB. Nothing was changed."
    fi
    log "Backup: $BACKUP_PATH"
  else
    log "Backup: skipped, there are no notes yet"
  fi

  # ------------------------------------------------------------ 5. stop the helper
  stop_helper "$PIDFILE"
  STARTED_PID=""

  # ------------------------------------------------------------ 6. replace the files
  local old_lock new_lock
  old_lock="$(shasum -a 256 package-lock.json 2>/dev/null | cut -d' ' -f1 || true)"
  new_lock="$(shasum -a 256 "$NEW/package-lock.json" | cut -d' ' -f1)"
  log "Replacing the files in $ROOT (keeping node_modules)"
  # --checksum: zip keeps times to 2 s, so a changed file of the same size can look unchanged.
  rsync -a --checksum --delete --exclude node_modules "$NEW/" "$ROOT/"
  # A changed lockfile always reinstalls the dependencies, whatever the file times say.
  [[ "$old_lock" == "$new_lock" ]] || rm -f node_modules/.package-lock.json

  # ------------------------------------------------------------ 7. install
  bash "$ROOT/scripts/install-extension.sh" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}
  log "Updated Overnote from $CURRENT to $(json_field "$ROOT/assets/prebuilt.json" version)."
  [[ -z "$BACKUP_PATH" ]] || log "Your notes were backed up first to $BACKUP_PATH"
}

# Starts the installed helper headless, the way the extension's launcher does: checksum, then
# the same arguments, then a ping.
start_helper() {
  local bin="$1" support="$2" runtime="$3" pidfile="$4" editor="$5"
  [[ -x "$bin" && -f "$bin.sha256" ]] || return 1
  [[ "$(shasum -a 256 "$bin" | cut -d' ' -f1)" == "$(cut -d' ' -f1 "$bin.sha256")" ]] || return 1
  mkdir -p -m 700 "$runtime"
  log "Starting the helper headless to back up the notes"
  "$bin" --support-dir "$support" --socket "$SOCKET" --pid-file "$pidfile" --editor-dir "$editor" --headless >/dev/null 2>&1 &
  STARTED_PID=$!
  disown "$STARTED_PID" 2>/dev/null || true
  local _
  for _ in $(seq 1 100); do
    rpc system.ping >/dev/null 2>&1 && return 0
    kill -0 "$STARTED_PID" 2>/dev/null || break
    sleep 0.1
  done
  log "The helper did not start"
  return 1
}

# Copies the database with sqlite3's online backup into the backups folder: sqlite_backup <db> <dir> <version>
sqlite_backup() {
  local db="$1" dir="$2" version="$3" stamp dest
  stamp="$(node -e 'const d = new Date().toISOString(); console.log(d.replace(/[-:]/g, ""))')"
  mkdir -p "$dir"
  chmod 700 "$dir"
  dest="$dir/notes-$stamp-v$version-pre-update.sqlite"
  (
    umask 077
    sqlite3 "$db" ".backup '$dest'" && sqlite3 "$dest" 'PRAGMA journal_mode = DELETE' >/dev/null
  ) || return 1
  rm -f "$dest-wal" "$dest-shm"
  chmod 600 "$dest"
  echo "$dest"
}

# Stops the helper: system.shutdown, then SIGTERM to the pid in its pid file.
stop_helper() {
  local pidfile="$1" pid="" ping _
  if ping="$(rpc system.ping 2>/dev/null)"; then
    pid="$(node -p 'JSON.parse(process.argv[1]).pid' "$ping")"
    log "Stopping the helper (pid $pid)"
    rpc system.shutdown '{}' 10 >/dev/null 2>&1 || true
  else
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    is_helper_pid "$pid" || return 0
    log "Stopping the helper (pid $pid), which does not answer"
  fi
  for _ in $(seq 1 50); do
    is_helper_pid "$pid" || return 0
    sleep 0.1
  done
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 50); do
    is_helper_pid "$pid" || return 0
    sleep 0.1
  done
  die "Could not stop the helper (pid $pid). Nothing was replaced."
}

cleanup() {
  # A helper this script started (and did not stop yet) runs headless, with no window, so it
  # must not outlive a failed update.
  if [[ -n "${STARTED_PID:-}" ]] && kill -0 "$STARTED_PID" 2>/dev/null; then
    rpc system.shutdown '{}' 10 >/dev/null 2>&1 || kill -TERM "$STARTED_PID" 2>/dev/null || true
  fi
  [[ -n "${WORK:-}" ]] && rm -rf "$WORK"
}

# The update replaces this very file, and bash reads a script as it runs, so everything above is
# a function and this last line (read in full before it runs) calls it.
main "$@"; exit $?
