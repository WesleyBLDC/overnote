#!/bin/bash
# End to end: install a release, update it, roll it back, and restore notes after the extension
# is removed, the way a person does it. Headless only: it never shows the panel and never talks
# to Raycast, and every path (HOME, support folder, socket, backups) is a temporary folder, so it
# never touches the real notes or the real backups.
#
#   bash scripts/e2e-update.sh
#
# Needs the built helper and editor (scripts/build-helper.sh, npm run build:editor).
#
# Flows:
#   1. Packages release N from this tree and fake releases N+1 and an old one (0.0.1, schema 0),
#      and serves them with a fake GitHub releases API from a local HTTP server.
#   2. Installs N with `npm run install-extension -- --no-register`, starts its helper headless,
#      and creates notes.
#   3. `npm run update-extension` to the latest (N+1) while the helper runs: the zip is checked,
#      a pre-update backup is written, the helper is stopped, the files are replaced (node_modules
#      kept, stale files gone), and the notes are intact under the new version.
#   4. Already up to date; a rollback below the database schema is refused and changes nothing.
#   5. A rollback to N with no helper running (the script starts one headless to back up), then
#      a reinstall whose helper cannot start (the sqlite3 .backup fallback).
#   6. A daily backup appears when the helper starts with notes and no recent backup.
#   7. Removal: the support folder is deleted, the helper starts empty and offers a restore,
#      system.restoreBackup brings the notes back (after a pre-restore backup), and paths outside
#      the backups folder are refused. Dismissing the offer sticks across a restart.
#
# Environment:
#   OVERNOTE_E2E_NPM_CI=1  run a real `npm ci` in the install folder instead of cloning this
#                          checkout's node_modules (slower; the release workflow already checks it)
#   OVERNOTE_LOG_DIR       on failure, copy the logs here (CI uploads this folder)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/assets/bin/OvernoteHelper"
[[ -x "$BIN" ]] || { echo "Helper not built: run scripts/build-helper.sh first" >&2; exit 1; }
[[ -f "$ROOT/assets/editor/index.html" ]] || { echo "Editor not built: run npm run build:editor first" >&2; exit 1; }
for tool in node sqlite3 zip unzip rsync; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

# Short, because socket paths are limited to 104 bytes on macOS.
TMP="$(mktemp -d /tmp/ovup.XXXXXX)"
TMP="$(cd "$TMP" && pwd -P)"
FAKE_HOME="$TMP/home"
SUPPORT="$FAKE_HOME/support"
BACKUPS="$FAKE_HOME/backups"
RUNTIME="$TMP/run"
SOCKET="$RUNTIME/helper.sock"
PIDFILE="$RUNTIME/helper.pid"
RELEASES="$TMP/releases"
APPS="$TMP/apps"
APP="$APPS/overnote"
LOGS="$TMP/logs"
mkdir -p "$FAKE_HOME" "$RELEASES" "$APPS" "$LOGS"
mkdir -m 700 "$RUNTIME"

# Everything below, the update script included, uses only these folders.
export OVERNOTE_SUPPORT_DIR="$SUPPORT"
export OVERNOTE_RUNTIME_DIR="$RUNTIME"
export OVERNOTE_BACKUP_DIR="$BACKUPS"
npm_config_cache="$(npm config get cache)"
export npm_config_cache
HELPER_PID=""
SERVER_PID=""
PASSED=0

cleanup() {
  local status=$?
  local pid
  for pid in "$HELPER_PID" "$(cat "$PIDFILE" 2>/dev/null || true)"; do
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  done
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ $status -ne 0 && -n "${OVERNOTE_LOG_DIR:-}" ]]; then
    mkdir -p "$OVERNOTE_LOG_DIR/e2e-update"
    cp "$LOGS"/* "$OVERNOTE_LOG_DIR/e2e-update/" 2>/dev/null || true
    [[ -f "$SUPPORT/helper.log" ]] && cp "$SUPPORT/helper.log" "$OVERNOTE_LOG_DIR/e2e-update/" || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

ok() { PASSED=$((PASSED + 1)); echo "[e2e-update] ok  $*"; }
fail() {
  echo "[e2e-update] FAILED: $*" >&2
  exit 1
}

# rpc <method> [params json]: prints the whole response line.
rpc() {
  local params="${2:-}"
  [[ -n "$params" ]] || params='{}'
  SOCKET="$SOCKET" node -e '
    const s = require("node:net").createConnection(process.env.SOCKET);
    let b = ""; s.setEncoding("utf8");
    s.on("data", (d) => { b += d; if (b.includes("\n")) process.stdout.write(b.split("\n")[0], () => process.exit(0)); });
    s.on("error", () => process.exit(1));
    s.write(JSON.stringify({ id: 1, method: process.argv[1], params: JSON.parse(process.argv[2]) }) + "\n");
    setTimeout(() => process.exit(1), 30000);' "$1" "$params"
}
# field <json> <js expression on r>: prints the value.
field() { node -e 'const r = JSON.parse(process.argv[1]); const v = eval(process.argv[2]); console.log(typeof v === "object" ? JSON.stringify(v) : v);' "$1" "$2"; }
json_field() { node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]' "$1" "$2"; }

start_helper() {
  "$APP/assets/bin/OvernoteHelper" --support-dir "$SUPPORT" --socket "$SOCKET" --pid-file "$PIDFILE" \
    --editor-dir "$APP/assets/editor" --headless --test-hooks >>"$LOGS/helper-stdout.log" 2>&1 &
  HELPER_PID=$!
  for _ in $(seq 1 300); do
    rpc system.ping 2>/dev/null | grep -q "\"pid\":$HELPER_PID" && return 0
    kill -0 "$HELPER_PID" 2>/dev/null || break
    sleep 0.05
  done
  fail "the helper never answered on its socket"
}

stop_helper() {
  rpc system.shutdown >/dev/null || true
  for _ in $(seq 1 300); do
    kill -0 "$HELPER_PID" 2>/dev/null || break
    sleep 0.05
  done
  kill -0 "$HELPER_PID" 2>/dev/null && fail "the helper did not exit"
  wait "$HELPER_PID" 2>/dev/null || true
  HELPER_PID=""
}

# Runs a command in the install folder as a person would, with the temporary HOME.
in_app() { (cd "$APP" && HOME="$FAKE_HOME" "$@"); }

note_titles() { rpc notes.list | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).result.items.map(n=>n.title+(n.pinned===null?"":"*")).join("|")))'; }

# ---------------------------------------------------------------- 1. releases and a fake API
N="$("$BIN" --version)"
# shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
NEXT="$(node -e 'const [a, b, c] = process.argv[1].split("-")[0].split(".").map(Number); console.log(`${a}.${b}.${c + 1}`)' "$N")"
OLD="0.0.1"
bash "$ROOT/scripts/package-release.sh" "$N" "$RELEASES/v$N" >"$LOGS/package.log" 2>&1 || { cat "$LOGS/package.log" >&2; fail "package-release.sh"; }
ZIP_N="$RELEASES/v$N/overnote-$N.zip"
unzip -p "$ZIP_N" overnote/scripts/update-extension.sh >/dev/null || fail "the release zip does not carry update-extension.sh"
[[ "$(unzip -p "$ZIP_N" overnote/assets/prebuilt.json | node -p 'JSON.parse(require("fs").readFileSync(0)).schemaVersion')" == "$("$BIN" --schema-version)" ]] ||
  fail "prebuilt.json does not record the helper's schema version"
ok "release $N packaged with update-extension.sh and schemaVersion in prebuilt.json"

# fake_release <version> <schemaVersion> <marker file>: release N with another version number.
fake_release() {
  local version="$1" schema="$2" marker="$3" stage="$TMP/stage-$1"
  mkdir -p "$stage" "$RELEASES/v$version"
  unzip -q "$ZIP_N" -d "$stage"
  node -e '
    const fs = require("fs"); const file = process.argv[1];
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    p.version = process.argv[2]; p.schemaVersion = Number(process.argv[3]);
    fs.writeFileSync(file, JSON.stringify(p, null, 2) + "\n");' "$stage/overnote/assets/prebuilt.json" "$version" "$schema"
  echo "$version" >"$stage/overnote/$marker"
  (cd "$stage" && zip -q -r -X "$RELEASES/v$version/overnote-$version.zip" overnote)
  (cd "$RELEASES/v$version" && shasum -a 256 "overnote-$version.zip" >SHA256SUMS)
}
fake_release "$NEXT" "$("$BIN" --schema-version)" NEXT_RELEASE
fake_release "$OLD" 0 OLD_RELEASE

cat >"$TMP/server.mjs" <<'EOF'
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
const [root, portFile] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end("{}");
  res.writeHead(200).end(fs.readFileSync(file));
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
EOF
node "$TMP/server.mjs" "$RELEASES" "$TMP/port" >>"$LOGS/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 300); do [[ -s "$TMP/port" ]] && break; sleep 0.05; done
[[ -s "$TMP/port" ]] || fail "the fake releases server did not start"
BASE="http://127.0.0.1:$(cat "$TMP/port")"
export OVERNOTE_RELEASES_API="$BASE/api"
mkdir -p "$RELEASES/api/tags"
release_json() {
  local version="$1"
  # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
  node -e '
    const [base, v] = process.argv.slice(1);
    const asset = (name) => ({ name, browser_download_url: `${base}/v${v}/${name}` });
    console.log(JSON.stringify({ tag_name: `v${v}`, html_url: `${base}/v${v}`, assets: [asset(`overnote-${v}.zip`), asset("SHA256SUMS")] }));' "$BASE" "$version"
}
for version in "$N" "$NEXT" "$OLD"; do release_json "$version" >"$RELEASES/api/tags/v$version"; done
release_json "$NEXT" >"$RELEASES/api/latest"
ok "fake releases $NEXT and $OLD served by a local releases API"

# ---------------------------------------------------------------- 2. install N and create notes
unzip -q "$ZIP_N" -d "$APPS"
if [[ "${OVERNOTE_E2E_NPM_CI:-0}" != "1" ]]; then
  # The same dependencies the lockfile names, cloned (copy on write) instead of downloaded.
  for modules in node_modules editor/node_modules packages/core/node_modules; do
    [[ -d "$ROOT/$modules" ]] || continue
    cp -cRp "$ROOT/$modules" "$APP/$modules" 2>/dev/null || cp -Rp "$ROOT/$modules" "$APP/$modules"
  done
  touch "$APP/node_modules/.package-lock.json"
fi
in_app npm run install-extension -- --no-register >"$LOGS/install.log" 2>&1 || { cat "$LOGS/install.log" >&2; fail "install-extension"; }
[[ "$(json_field "$APP/assets/prebuilt.json" version)" == "$N" ]] || fail "the install is not version $N"
[[ "$(json_field "$APP/assets/install-location.json" installDir)" == "$APP" ]] || fail "install-location.json does not name the install folder"
ok "release $N installed with --no-register; install-location.json names $APP"

start_helper
for text in "Groceries" "Trip plan" "Ideas"; do
  rpc notes.create "{\"rawContent\":\"{}\",\"text\":\"$text\",\"title\":\"$text\",\"markdown\":\"$text\"}" | grep -q '"result"' || fail "notes.create"
  sleep 0.01
done
ideas="$(rpc notes.list | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).result.items.find(n=>n.title==="Ideas").id))')"
rpc notes.pin "{\"id\":\"$ideas\"}" >/dev/null
BEFORE="$(note_titles)"
[[ "$BEFORE" == "Ideas*|Trip plan|Groceries" ]] || fail "unexpected notes before the update: $BEFORE"
echo "stale" >"$APP/STALE_FILE"
modules_inode="$(stat -f %i "$APP/node_modules")"
ok "helper $N running headless with notes: $BEFORE"

# ---------------------------------------------------------------- 3. update to the latest
in_app npm run update-extension -- --no-register >"$LOGS/update.log" 2>&1 || { cat "$LOGS/update.log" >&2; fail "update-extension"; }
grep -q "Updated Overnote from $N to $NEXT" "$LOGS/update.log" || { cat "$LOGS/update.log" >&2; fail "the update did not report $N to $NEXT"; }
kill -0 "$HELPER_PID" 2>/dev/null && fail "the update left the old helper running"
wait "$HELPER_PID" 2>/dev/null || true
HELPER_PID=""
[[ "$(json_field "$APP/assets/prebuilt.json" version)" == "$NEXT" ]] || fail "prebuilt.json is not $NEXT after the update"
[[ -f "$APP/NEXT_RELEASE" ]] || fail "the new release's files are missing"
[[ ! -e "$APP/STALE_FILE" ]] || fail "a file the new release does not have was kept"
[[ "$(stat -f %i "$APP/node_modules")" == "$modules_inode" ]] || fail "node_modules was replaced"
[[ "$(json_field "$APP/assets/install-location.json" installDir)" == "$APP" ]] || fail "install-location.json was not written again"
ok "updated $N to $NEXT: helper stopped, files replaced, stale file gone, node_modules kept"

shopt -s nullglob
pre_update=("$BACKUPS"/notes-*-v"$N"-pre-update.sqlite)
((${#pre_update[@]} == 1)) || fail "expected one pre-update backup, found: $(ls "$BACKUPS" 2>/dev/null)"
[[ "$(basename "${pre_update[0]}")" =~ ^notes-[0-9]{8}T[0-9]{6}\.[0-9]{3}Z-v$N-pre-update\.sqlite$ ]] || fail "backup name ${pre_update[0]}"
[[ "$(stat -f %Lp "$BACKUPS")" == "700" ]] || fail "the backups folder is not 0700"
[[ "$(stat -f %Lp "${pre_update[0]}")" == "600" ]] || fail "the backup is not 0600"
[[ "$(sqlite3 -readonly "${pre_update[0]}" 'SELECT count(*) FROM notes')" == "3" ]] || fail "the pre-update backup does not hold the 3 notes"
[[ "$(sqlite3 -readonly "${pre_update[0]}" 'PRAGMA journal_mode')" == "delete" ]] || fail "the backup is not a self contained file"
leftovers="$(find "$BACKUPS" -mindepth 1 \( -name '*-wal' -o -name '*-shm' -o -name '*.partial*' \) -print)"
[[ -z "$leftovers" ]] || fail "the backups folder has leftover files: $leftovers"
ok "pre-update backup $(basename "${pre_update[0]}") (0600 in a 0700 folder, 3 notes, no -wal)"

start_helper
AFTER="$(note_titles)"
[[ "$AFTER" == "$BEFORE" ]] || fail "notes changed across the update: $AFTER"
ok "notes intact after the update: $AFTER"

# ---------------------------------------------------------------- 4. up to date, and the rollback guard
in_app npm run update-extension -- --no-register >"$LOGS/update-again.log" 2>&1 || fail "a second update should succeed"
grep -q "already installed" "$LOGS/update-again.log" || fail "a second update did not say it was up to date"
ok "already up to date: nothing to do"

status=0
in_app npm run update-extension -- --version "v$OLD" --no-register >"$LOGS/rollback-refused.log" 2>&1 || status=$?
[[ $status -ne 0 ]] || fail "a rollback below the database schema should fail"
grep -q "Refusing to install $OLD" "$LOGS/rollback-refused.log" || { cat "$LOGS/rollback-refused.log" >&2; fail "the refusal was not explained"; }
[[ "$(json_field "$APP/assets/prebuilt.json" version)" == "$NEXT" && ! -e "$APP/OLD_RELEASE" ]] || fail "the refused rollback changed the install"
rpc system.ping | grep -q "\"pid\":$HELPER_PID" || fail "the refused rollback stopped the helper"
ok "rollback to $OLD (schema 0) refused below the database's schema 1; install and helper untouched"

# ---------------------------------------------------------------- 5. rollback with no helper, then the sqlite3 fallback
stop_helper
in_app npm run update-extension -- --version "v$N" --no-register >"$LOGS/rollback.log" 2>&1 || { cat "$LOGS/rollback.log" >&2; fail "the rollback to $N"; }
grep -q "Starting the helper headless" "$LOGS/rollback.log" || fail "the update did not start the helper to back up"
grep -q "Updated Overnote from $NEXT to $N" "$LOGS/rollback.log" || fail "the rollback did not report $NEXT to $N"
[[ -z "$(pgrep -f "$SUPPORT" || true)" ]] || fail "the helper the update started is still running"
[[ ! -e "$APP/NEXT_RELEASE" ]] || fail "the rollback kept a file of $NEXT"
# Helper backups carry the helper's version, which the fake releases share with N.
pre_update=("$BACKUPS"/notes-*-v"$N"-pre-update.sqlite)
((${#pre_update[@]} == 2)) || fail "the rollback wrote no pre-update backup"
ok "rollback to $N with no helper running: started headless, backed up, stopped again"

echo "0000000000000000000000000000000000000000000000000000000000000000  OvernoteHelper" >"$APP/assets/bin/OvernoteHelper.sha256"
in_app npm run update-extension -- --version "v$N" --force --no-register >"$LOGS/fallback.log" 2>&1 || { cat "$LOGS/fallback.log" >&2; fail "the reinstall with a helper that cannot start"; }
grep -q "copying the database with sqlite3" "$LOGS/fallback.log" || { cat "$LOGS/fallback.log" >&2; fail "the sqlite3 fallback did not run"; }
fallback=("$BACKUPS"/notes-*-v"$N"-pre-update.sqlite)
((${#fallback[@]} == 3)) || fail "the sqlite3 fallback wrote no backup"
newest="$(printf '%s\n' "$BACKUPS"/notes-*-v"$N"-pre-update.sqlite | sort | tail -n 1)"
[[ "$(stat -f %Lp "$newest")" == "600" && "$(sqlite3 -readonly "$newest" 'SELECT count(*) FROM notes')" == "3" ]] || fail "the sqlite3 backup is wrong"
[[ "$(shasum -a 256 "$APP/assets/bin/OvernoteHelper" | cut -d' ' -f1)" == "$(cut -d' ' -f1 "$APP/assets/bin/OvernoteHelper.sha256")" ]] || fail "the reinstall did not restore the checksum"
ok "a helper that cannot start falls back to sqlite3 .backup (0600, 3 notes)"

# ---------------------------------------------------------------- 6. a daily backup
OVERNOTE_BACKUP_DIR="$TMP/daily" start_helper
for _ in $(seq 1 300); do compgen -G "$TMP/daily/notes-*-v$N-daily.sqlite" >/dev/null && break; sleep 0.05; done
compgen -G "$TMP/daily/notes-*-v$N-daily.sqlite" >/dev/null || fail "no daily backup after starting with notes and no backups"
stop_helper
ok "daily backup written at startup when the newest backup is older than 24 hours"

# ---------------------------------------------------------------- 7. removal and restore
rm -rf "$SUPPORT"
start_helper
status_json="$(rpc system.status)"
[[ "$(field "$status_json" 'r.result.restoreAvailable')" == "true" ]] || fail "no restore offered after removal: $status_json"
[[ "$(field "$status_json" 'r.result.noteCount')" == "0" ]] || fail "the fresh database is not empty"
[[ "$(field "$status_json" 'r.result.backupDir')" == "$BACKUPS" ]] || fail "system.status names another backups folder"
count_before="$(find "$BACKUPS" -mindepth 1 -maxdepth 1 -name 'notes-*.sqlite' | wc -l | tr -d ' ')"
ok "after removal the helper starts empty, overwrites nothing, and offers a restore ($count_before backups)"

# A real backup, with a backup's name, one folder up.
cp "$newest" "$FAKE_HOME/$(basename "$newest")"
for bad in "/etc/passwd" "$BACKUPS/../$(basename "$newest")" "relative.sqlite" "$SUPPORT/notes.sqlite"; do
  rpc system.restoreBackup "{\"path\":\"$bad\"}" | grep -q '"error"' || fail "restoring $bad should be refused"
done
ln -s /etc/hosts "$BACKUPS/notes-20200101T000000.000Z-v$N-manual.sqlite"
rpc system.restoreBackup "{\"path\":\"$BACKUPS/notes-20200101T000000.000Z-v$N-manual.sqlite\"}" | grep -q '"code":-32602' || fail "a symlink out of the folder should be refused"
rm "$BACKUPS/notes-20200101T000000.000Z-v$N-manual.sqlite"
ok "restore refuses paths outside the backups folder, other files, and symlinks"

listed="$(rpc system.listBackups)"
chosen="$(field "$listed" 'r.result.items.find((b) => b.reason === "pre-update").path')"
[[ "$chosen" == "$newest" ]] || fail "listBackups is not newest first: $chosen"
restored="$(rpc system.restoreBackup "{\"path\":\"$chosen\"}")"
[[ "$(field "$restored" 'r.result.noteCount')" == "3" ]] || fail "restore: $restored"
[[ "$(field "$restored" 'r.result.preRestoreBackup.reason')" == "pre-restore" ]] || fail "no pre-restore backup"
[[ -f "$(field "$restored" 'r.result.preRestoreBackup.path')" ]] || fail "the pre-restore backup file is missing"
[[ "$(note_titles)" == "$BEFORE" ]] || fail "the restored notes differ: $(note_titles)"
rpc test.events | grep -q '"notes.changed"' || fail "the restore did not emit notes.changed"
[[ "$(field "$(rpc system.status)" 'r.result.restoreAvailable')" == "false" ]] || fail "the offer is still up after the restore"
stop_helper
start_helper
[[ "$(note_titles)" == "$BEFORE" ]] || fail "the restored notes did not persist"
[[ "$(field "$(rpc system.status)" 'r.result.restoreAvailable')" == "false" ]] || fail "the offer came back after a restart"
stop_helper
ok "restored $(basename "$chosen"): notes back, pre-restore backup written, notes.changed emitted, persisted"

rm -rf "$SUPPORT"
start_helper
[[ "$(field "$(rpc system.status)" 'r.result.restoreAvailable')" == "true" ]] || fail "no offer on the second removal"
rpc system.dismissRestoreOffer | grep -q '"result":{}' || fail "dismissRestoreOffer"
stop_helper
start_helper
[[ "$(field "$(rpc system.status)" 'r.result.restoreAvailable')" == "false" ]] || fail "the dismissed offer came back"
stop_helper
ok "a dismissed restore offer stays dismissed across a restart"

echo "[e2e-update] all $PASSED checks passed"
