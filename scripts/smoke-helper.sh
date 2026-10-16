#!/bin/bash
# End to end tests of the built helper binary over its real socket.
#
# Starts assets/bin/OvernoteHelper (or $HELPER) with temp directories and drives it the
# way the extension and the editor do. This is where the helper's behavior is tested; the
# unit suite (helper/test.sh) only keeps pure logic that is hard to reach from here.
#
# Flows:
#   1. lifecycle: --version, bad arguments, socket and PID file permissions, single
#      instance, a newer database schema refused, stale socket recovery after a crash
#   2. purge at startup: trashed notes older than 60 days are removed when the helper starts
#   3. notes, lists, window data, settings, errors, and events over one connection
#   4. concurrency: many clients, pipelined bursts, a half closed connection, a large note
#   5. persistence across a restart, then SIGTERM and system.shutdown clean up
#
# Usage: scripts/smoke-helper.sh [--gui]
#   --gui  run without --headless. The hidden, prewarmed panel's placeholder editor then
#          creates the first note through the bridge, which proves WKWebView, the scheme
#          handler, and the bridge work in this binary. The panel is never shown.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="${HELPER:-$ROOT/assets/bin/OvernoteHelper}"
GUI_MODE=0
[[ "${1:-}" == "--gui" ]] && GUI_MODE=1

[[ -x "$HELPER" ]] || { echo "Helper not built: run scripts/build-helper.sh first" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required for the smoke client" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "sqlite3 is required" >&2; exit 1; }

TMP="$(mktemp -d /tmp/overnote-smoke.XXXXXX)"
# Never write into the real backups folder.
export OVERNOTE_BACKUP_DIR="$TMP/backups"
SUPPORT="$TMP/support"
RUN="$TMP/run"
SOCKET="$RUN/helper.sock"
PIDFILE="$RUN/helper.pid"
DB="$SUPPORT/notes.sqlite"
HELPER_PID=""
PASSED=0

cleanup() {
  local status=$?
  if [[ -n "$HELPER_PID" ]] && kill -0 "$HELPER_PID" 2>/dev/null; then
    kill -KILL "$HELPER_PID" 2>/dev/null || true
  fi
  # On failure, keep the helper's logs where CI uploads them (OVERNOTE_LOG_DIR).
  if [[ $status -ne 0 && -n "${OVERNOTE_LOG_DIR:-}" ]]; then
    mkdir -p "$OVERNOTE_LOG_DIR/smoke-helper"
    for log in "$SUPPORT/helper.log" "$TMP/stdout.log"; do
      [[ -f "$log" ]] && cp "$log" "$OVERNOTE_LOG_DIR/smoke-helper/"
    done
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

ok() { PASSED=$((PASSED + 1)); echo "[smoke] ok  $*"; }
fail() { echo "[smoke] FAILED: $*" >&2; exit 1; }

start_helper() {
  local mode=(--headless --test-hooks)
  [[ "$GUI_MODE" == "1" ]] && mode=(--test-hooks)
  "$HELPER" --support-dir "$SUPPORT" --socket "$SOCKET" --pid-file "$PIDFILE" --editor-dir "$TMP/no-editor" \
    "${mode[@]}" >>"$TMP/stdout.log" 2>&1 &
  HELPER_PID=$!
  # Wait for this process to answer, not just for a socket file: a crashed helper leaves
  # a stale one behind until the new helper replaces it. The bound (15 s) only matters when
  # something is wrong; a healthy start answers within a few polls.
  for _ in $(seq 1 300); do
    if [[ -S "$SOCKET" ]] && rpc '{"id":0,"method":"system.ping"}' 2>/dev/null | grep -q "\"pid\":$HELPER_PID"; then
      return 0
    fi
    kill -0 "$HELPER_PID" 2>/dev/null || break
    sleep 0.05
  done
  cat "$TMP/stdout.log" >&2
  fail "helper never answered on its socket"
}

wait_exit() {
  for _ in $(seq 1 200); do
    kill -0 "$HELPER_PID" 2>/dev/null || break
    sleep 0.05
  done
  kill -0 "$HELPER_PID" 2>/dev/null && fail "helper did not exit"
  local status=0
  wait "$HELPER_PID" || status=$?
  HELPER_PID=""
  return "$status"
}

rpc() {
  # rpc '<json line>' prints the response line.
  SOCKET="$SOCKET" node -e '
    const s = require("node:net").createConnection(process.env.SOCKET);
    let b = ""; s.setEncoding("utf8");
    s.on("data", (d) => { b += d; if (b.includes("\n")) { process.stdout.write(b, () => process.exit(0)); } });
    s.write(process.argv[1] + "\n");
    s.on("error", () => process.exit(1));
    setTimeout(() => process.exit(1), 3000);' "$1"
}

# ---------------------------------------------------------------- 1. lifecycle
[[ "$("$HELPER" --version)" == "$(tr -d '[:space:]' < "$ROOT/helper/VERSION")" ]] || fail "--version does not match helper/VERSION"
status=0; "$HELPER" --bogus >/dev/null 2>&1 || status=$?
[[ "$status" == "64" ]] || fail "unknown arguments should exit 64, got $status"
status=0; "$HELPER" >/dev/null 2>&1 || status=$?
[[ "$status" == "64" ]] || fail "a missing --support-dir should exit 64, got $status"
ok "--version and argument errors"

start_helper
[[ "$(stat -f %Lp "$RUN")" == "700" ]] || fail "socket dir is not 0700"
[[ "$(stat -f %Lp "$SOCKET")" == "600" ]] || fail "socket is not 0600"
[[ "$(cat "$PIDFILE")" == "$HELPER_PID" ]] || fail "PID file does not hold the helper pid"
ok "socket 0600 in a 0700 directory, PID file written"

"$HELPER" --support-dir "$SUPPORT" --socket "$SOCKET" --pid-file "$PIDFILE" --headless || fail "a second instance should exit 0"
kill -0 "$HELPER_PID" || fail "the second instance disturbed the first"
ok "a second instance exits 0 and leaves the first running"

# A crash (SIGKILL) leaves the socket and PID file behind; the next start recovers.
kill -KILL "$HELPER_PID"; wait "$HELPER_PID" 2>/dev/null || true; HELPER_PID=""
[[ -S "$SOCKET" && -f "$PIDFILE" ]] || fail "expected stale files after a crash"
start_helper
rpc '{"id":1,"method":"system.ping"}' | grep -q "\"pid\":$HELPER_PID" || fail "ping after crash recovery"
ok "stale socket and PID file recovered after a crash"
rpc '{"id":1,"method":"system.shutdown"}' >/dev/null
wait_exit || fail "system.shutdown should exit 0"

# A database from a newer helper is refused rather than touched.
cp "$DB" "$TMP/backup.sqlite"
sqlite3 "$DB" "PRAGMA user_version = 99"
status=0; "$HELPER" --support-dir "$SUPPORT" --socket "$SOCKET" --pid-file "$PIDFILE" --headless >/dev/null 2>&1 || status=$?
[[ "$status" == "1" ]] || fail "a newer schema should exit 1, got $status"
grep -q "newer than this helper supports" "$SUPPORT/helper.log" || fail "newer schema not logged"
[[ ! -e "$PIDFILE" ]] || fail "PID file left after refusing to start"
cp "$TMP/backup.sqlite" "$DB"; rm -f "$DB-wal" "$DB-shm"
ok "a newer database schema is refused and logged"

# ---------------------------------------------------------------- 2. purge at startup
NOW_MS=$(( $(date +%s) * 1000 ))
DAY_MS=86400000
sqlite3 "$DB" "
  INSERT INTO notes (id, title, text, raw_content, created_at, updated_at, deleted_at, last_accessed_at)
  VALUES ('01OLDTRASH0000000000000000', 'old', 'old', '{}', 1, 1, $((NOW_MS - 61 * DAY_MS)), 1),
         ('01KEEPTRASH000000000000000', 'keep', 'keep', '{}', 1, 1, $((NOW_MS - 59 * DAY_MS)), 1);"
start_helper
remaining="$(sqlite3 "$DB" "SELECT group_concat(id) FROM notes WHERE deleted_at IS NOT NULL")"
[[ "$remaining" == "01KEEPTRASH000000000000000" ]] || fail "purge at startup left: $remaining"
# Remove the kept row through the helper (a raw DELETE could race the --gui placeholder's first note).
rpc '{"id":1,"method":"notes.permanentlyDelete","params":{"id":"01KEEPTRASH000000000000000"}}' | grep -q '"result":{}' \
  || fail "could not remove the kept trash row"
ok "startup purge removes trash older than 60 days and keeps newer trash"

# ---------------------------------------------------------------- 3 and 4. RPC flows
GUI_MODE="$GUI_MODE" SOCKET="$SOCKET" COUNT_FILE="$TMP/rpc-count" node - <<'JS'
const net = require("node:net");
const assert = require("node:assert/strict");

let passed = 0;
const ok = (name) => { passed++; console.log(`[smoke] ok  ${name}`); };

function connect() {
  const socket = net.createConnection(process.env.SOCKET);
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (method, params = {}, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    socket.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const call = async (method, params, timeoutMs) => {
    const message = await request(method, params, timeoutMs);
    if (message.error) throw Object.assign(new Error(`${method}: ${message.error.message}`), { code: message.error.code });
    return message.result;
  };
  return { socket, request, call };
}

const { socket, request, call } = connect();
const content = (text, title) => ({
  rawContent: JSON.stringify({ type: "doc" }), markdown: text, text, title: title ?? text.split("\n")[0],
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function expectError(code, method, params) {
  const message = await request(method, params);
  assert.equal(message.error?.code, code, `${method} ${JSON.stringify(params)} should fail with ${code}`);
}
const events = () => call("test.events");
const lastEvent = async (name) => (await events()).filter((e) => e.event === name).at(-1);

(async () => {
  if (process.env.GUI_MODE === "1") {
    let count = 0;
    for (let i = 0; i < 300 && (count = (await call("notes.count")).count) === 0; i++) await sleep(50);
    assert.equal(count, 1, "the placeholder editor did not create its note through the bridge");
    await call("notes.deleteAll");
    await call("notes.emptyTrash");
    ok("hidden panel: WKWebView, scheme handler, and bridge work");
  }

  // ---- notes lifecycle
  const a = await call("notes.create", content("Café list\nmilk"));
  assert.match(a.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(a.caretPosition, 0);
  assert.equal(a.createdAt, a.updatedAt);
  assert.equal(a.lastAccessedAt, a.updatedAt);
  assert.equal(a.pinned, null);
  assert.deepEqual(await call("notes.get", { id: a.id }), a);
  ok("create stores content verbatim with fresh timestamps and caret 0");

  const updated = await call("notes.update", { id: a.id, ...content("Café list\nmilk and eggs"), expectedUpdatedAt: a.updatedAt });
  assert.equal(updated.status, "ok");
  assert.ok(updated.note.updatedAt > a.updatedAt);
  const conflict = await call("notes.update", { id: a.id, text: "stale", expectedUpdatedAt: a.updatedAt });
  assert.deepEqual(conflict, { status: "conflict", note: updated.note });
  const caret = await call("notes.update", { id: a.id, caretPosition: 7 });
  assert.equal(caret.note.caretPosition, 7);
  assert.equal(caret.note.updatedAt, updated.note.updatedAt);
  ok("update: content moves updatedAt, stale expectations conflict, caret only keeps updatedAt");

  const b = await call("notes.create", content("Second note"));
  await call("notes.pin", { id: b.id });
  await call("notes.delete", { id: b.id });
  const trashed = await call("notes.get", { id: b.id });
  assert.equal(trashed.pinned, null);
  assert.equal(trashed.updatedAt, b.updatedAt + 1);
  assert.ok(trashed.deletedAt >= b.updatedAt);
  await call("notes.delete", { id: b.id });
  assert.deepEqual(await call("notes.get", { id: b.id }), trashed);
  const caretOnTrash = await call("notes.update", { id: b.id, caretPosition: 99 });
  assert.equal(caretOnTrash.note.caretPosition, 0);
  await call("notes.touchAccessed", { id: b.id });
  assert.equal((await call("notes.get", { id: b.id })).lastAccessedAt, trashed.lastAccessedAt);
  ok("delete clears the pin, steps updatedAt by 1 ms, and is idempotent; trashed notes ignore caret and touch");

  const deleted = await call("notes.listDeleted");
  assert.deepEqual(deleted.items.map((n) => n.id), [b.id]);
  assert.equal(deleted.items[0].markdown, "Second note");
  assert.equal(deleted.items[0].rawContent, JSON.stringify({ type: "doc" }));
  const recovered = await call("notes.recover", { id: b.id });
  assert.equal(recovered.deletedAt, null);
  assert.equal(recovered.pinned, null);
  assert.equal(recovered.updatedAt, trashed.updatedAt + 1);
  ok("listDeleted carries markdown and rawContent; recover leaves the note unpinned and steps updatedAt");

  assert.deepEqual(await call("notes.permanentlyDelete", { id: b.id }), {});
  assert.equal((await call("notes.get", { id: b.id })).id, b.id);
  await call("notes.delete", { id: b.id });
  await call("notes.permanentlyDelete", { id: b.id });
  await expectError(404, "notes.get", { id: b.id });
  ok("permanentlyDelete ignores live notes and removes trashed ones");

  const dup = await call("notes.duplicate", { id: a.id, titleSuffix: " copy" });
  assert.notEqual(dup.id, a.id);
  assert.equal(dup.title, "Café list copy");
  assert.equal(dup.text, updated.note.text);
  assert.equal(dup.caretPosition, 0);
  assert.equal(dup.pinned, null);
  assert.ok(dup.createdAt >= updated.note.updatedAt);
  assert.equal((await call("notes.windowData")).current.id, dup.id);
  ok("duplicate: fresh timestamps, no pin, caret 0, title suffix, becomes current");

  // ---- lists and filters
  const german = await call("notes.create", content("Straße ÜBER alles"));
  const long = await call("notes.create", content("é".repeat(250), "long"));
  assert.deepEqual((await call("notes.list", { filter: "über" })).items.map((n) => n.id), [german.id]);
  assert.deepEqual((await call("notes.list", { filter: "UBER" })).items.map((n) => n.id), [german.id]);
  assert.deepEqual((await call("notes.list", { filter: "STRASSE" })).items, []);
  assert.deepEqual((await call("notes.list", { filter: "cafe" })).items.map((n) => n.id).sort(), [a.id, dup.id].sort());
  const longRow = (await call("notes.list", { filter: "long" })).items[0];
  assert.equal(longRow.charCount, 250);
  assert.equal([...longRow.preview].length, 200);
  assert.deepEqual(Object.keys(longRow).sort(),
    ["charCount", "createdAt", "deletedAt", "id", "lastAccessedAt", "pinned", "preview", "title", "updatedAt"]);
  ok("filters fold case and diacritics (not ß); rows carry charCount and a 200 character preview");

  const page1 = await call("notes.browse", { limit: 2 });
  const page2 = await call("notes.browse", { limit: 2, cursor: page1.nextCursor });
  assert.equal(page1.items.length + page2.items.length, 4);
  await expectError(-32602, "notes.list", { cursor: page1.nextCursor });
  ok("browse pages with cursors, and a browse cursor is refused by list");

  // ---- window data and pins
  for (const note of [german, long]) await call("notes.delete", { id: note.id });
  const stack = [];
  // Distinct milliseconds, so updatedAt alone orders the window stack.
  for (let i = 0; i < 12; i++) { stack.push(await call("notes.create", content(`stack ${i}`))); await sleep(3); }
  for (const note of stack) await call("notes.pin", { id: note.id });
  let data = await call("notes.windowData", { noteId: stack[5].id });
  assert.equal(data.current.id, stack[5].id);
  assert.equal(data.previousNoteId, stack[6].id);
  assert.equal(data.nextNoteId, stack[4].id);
  assert.deepEqual(data.pinnedShortcutNoteIds, stack.slice(0, 9).map((n) => n.id));
  await call("notes.movePinnedUp", { id: stack[1].id });
  data = await call("notes.windowData", { noteId: stack[5].id });
  assert.deepEqual(data.pinnedShortcutNoteIds.slice(0, 2), [stack[1].id, stack[0].id]);
  ok("windowData neighbors follow updatedAt, 9 pin shortcuts, moves reorder pins");

  await call("notes.setCurrentNote", { noteId: "not-validated" });
  assert.equal((await call("notes.windowData")).current.id, stack[11].id);
  await call("notes.setCurrentNote", { noteId: stack[2].id });
  assert.equal((await call("notes.windowData")).current.id, stack[2].id);
  await call("notes.delete", { id: stack[2].id });
  assert.equal((await call("notes.windowData")).current.id, stack[11].id);
  ok("the persisted current note falls back to the most recently updated live note");

  const count = (await call("notes.count")).count;
  assert.equal((await call("notes.deleteAll")).count, count);
  assert.equal((await call("notes.count")).count, 0);
  assert.equal((await call("notes.windowData")).current, null);
  assert.ok((await call("notes.emptyTrash")).count >= count);
  assert.deepEqual((await call("notes.listDeleted")).items, []);
  ok("deleteAll, empty window data, emptyTrash");

  // ---- settings
  const defaults = await call("settings.get");
  assert.deepEqual(defaults, {
    escapeLosesFocus: false, hideWhileScreenSharing: false, zoom: 1, showFormatBar: false,
    countMode: "characters", windowAutoSize: false, panelFrame: null,
  });
  let settings = await call("settings.set", { zoom: 1.13, countMode: "words" });
  assert.equal(settings.zoom, 1.15);
  assert.equal((await call("settings.set", { zoom: 9 })).zoom, 2);
  assert.equal((await call("settings.set", { zoom: 0.1 })).zoom, 0.75);
  const frame = { x: 10, y: 900, width: 600, height: 420, displays: { "uuid@1728x1117": { x: 10, y: 900 } } };
  settings = await call("settings.set", { panelFrame: frame, windowAutoSize: false });
  assert.deepEqual(settings.panelFrame, frame);
  assert.deepEqual((await call("settings.set", { panelFrame: { x: 1, y: 2, width: 300 } })).panelFrame, { x: 1, y: 2, width: 300 });
  for (const bad of [{ zoom: "big" }, { countMode: "lines" }, { unknown: true }, { currentNoteId: "x" },
    { panelFrame: { x: 1 } }, { showFormatBar: true, escapeLosesFocus: 1 }]) {
    await expectError(-32602, "settings.set", bad);
  }
  assert.equal((await call("settings.get")).showFormatBar, false);
  assert.equal((await lastEvent("settings.changed")).payload.zoom, 0.75);
  ok("settings: partial updates, zoom snap and clamp, per display panelFrame, atomic validation, settings.changed");

  // settings.reset: every setting back to its default, the frame forgotten; the current note stays.
  const kept = await call("notes.create", content("kept current"));
  await call("window.show", { noteId: kept.id });
  const currentBefore = (await call("notes.windowData", {})).current?.id ?? null;
  assert.equal(currentBefore, kept.id);
  await call("settings.set", { zoom: 1.5, showFormatBar: true, countMode: "words" });
  const reset = await call("settings.reset");
  assert.deepEqual(reset, defaults);
  assert.deepEqual(await call("settings.get"), defaults);
  assert.deepEqual((await lastEvent("settings.changed")).payload, defaults);
  assert.equal((await call("notes.windowData", {})).current?.id ?? null, currentBefore);
  await call("notes.delete", { id: kept.id });
  await call("notes.permanentlyDelete", { id: kept.id });
  ok("settings.reset: defaults stored and announced, the current note kept");

  // ---- errors and events
  await expectError(-32601, "notes.search", { query: "x" });
  await expectError(-32601, "notes.navigate", { direction: "back" });
  for (const method of ["system.ready", "window.resize", "window.setOverhang", "window.setDragRegions", "window.resignFocus", "app.openURL",
    "clipboard.copy", "file.saveAs"]) {
    await expectError(-32601, method, {});
  }
  for (const [method, params] of [["notes.get", {}], ["notes.get", { id: 5 }], ["notes.get", { id: "" }],
    ["notes.create", { text: "no raw content" }], ["notes.list", { limit: 0 }], ["notes.list", { limit: "ten" }],
    ["notes.update", { id: "x", caretPosition: 1.5 }], ["notes.setCurrentNote", {}], ["notes.get", []],
    ["notes.list", { cursor: "garbage" }], ["notes.browse", { cursor: "garbage" }]]) {
    await expectError(-32602, method, params);
  }
  await expectError(404, "notes.get", { id: "missing" });
  await expectError(404, "notes.delete", { id: "missing" });
  await expectError(404, "window.show", { noteId: "missing" });
  const loose = await call("notes.create", content("loose"));
  await expectError(409, "notes.movePinnedUp", { id: loose.id });
  ok("error codes: -32601 unknown and bridge only, -32602 bad params, 404, 409");

  // The panel must never appear during this script; window events are covered by e2e-window.sh.
  if (process.env.GUI_MODE === "1") {
    await call("notes.create", content("from Create Note"));
    console.log("[smoke] skip show events in --gui mode (they would show the panel)");
  } else {
  const shown = await call("notes.create", { ...content("from Create Note"), show: true });
  assert.deepEqual((await lastEvent("note.new")).payload.note, shown);
  assert.ok((await lastEvent("notes.changed")).payload.ids.includes(shown.id));
  if (process.env.GUI_MODE !== "1") assert.equal(await call("test.visible"), true);
  await call("window.hide");
  assert.deepEqual(await call("window.show", { noteId: loose.id }), { visible: true });
  assert.deepEqual((await lastEvent("note.open")).payload, { id: loose.id });
  assert.equal((await call("notes.windowData")).current.id, loose.id);
  assert.deepEqual(await call("window.hide"), { visible: false });
  ok("events: note.new on create with show, notes.changed, note.open on window.show");
  }

  // ---- concurrency and framing
  const workers = await Promise.all(Array.from({ length: 8 }, async (_, worker) => {
    const client = connect();
    const created = [];
    for (let i = 0; i < 10; i++) created.push(await client.call("notes.create", content(`w${worker} ${i}`)));
    client.socket.end();
    return created.length;
  }));
  assert.equal(workers.reduce((x, y) => x + y, 0), 80);
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => call("notes.create", content(`burst ${i}`))));
  assert.equal(new Set(burst.map((n) => n.id)).size, 40);
  assert.equal((await call("notes.count")).count, 2 + 80 + 40);
  ok("8 concurrent clients and a 40 request burst on one connection, matched by id");

  const halfClosed = await new Promise((resolve, reject) => {
    const s = net.createConnection(process.env.SOCKET);
    let data = "";
    s.setEncoding("utf8");
    s.on("data", (d) => { data += d; });
    s.on("end", () => resolve(data));
    s.on("error", reject);
    s.end(JSON.stringify({ id: "h", method: "system.ping" }) + "\n");
  });
  assert.equal(JSON.parse(halfClosed.trim()).id, "h");
  ok("a request sent with a half close is still answered");

  const big = "x".repeat(1024 * 1024) + "\n" + "🙂".repeat(1000);
  const bigNote = await call("notes.create", content(big, "big"));
  assert.equal((await call("notes.get", { id: bigNote.id })).text, big);
  ok("a 1 MB note round trips intact");

  // A client that sends many requests for that note and never reads must not hold up anyone else:
  // its responses wait on its own connection, and it is dropped once a write has waited 5 s.
  const stuck = net.createConnection(process.env.SOCKET);
  await new Promise((resolve) => stuck.on("connect", resolve));
  stuck.pause();
  stuck.write(Array.from({ length: 200 }, (_, i) => JSON.stringify({ id: i, method: "notes.get", params: { id: bigNote.id } }) + "\n").join(""));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const pingStart = Date.now();
  await call("system.ping");
  const pingMs = Date.now() - pingStart;
  stuck.destroy();
  assert.ok(pingMs < 1000, `ping took ${pingMs} ms while a client was not reading`);
  ok(`a client that stops reading does not hold up others (ping in ${pingMs} ms)`);

  await call("settings.set", { escapeLosesFocus: true });
  socket.end();
  require("node:fs").writeFileSync(process.env.COUNT_FILE, String(passed));
})().catch((error) => {
  console.error("[smoke] FAILED:", error.message);
  process.exit(1);
});
JS
RPC_PASSED="$(cat "$TMP/rpc-count")"

# ---------------------------------------------------------------- 5. persistence and shutdown
kill -TERM "$HELPER_PID"
wait_exit || fail "SIGTERM should exit 0"
[[ ! -e "$SOCKET" ]] || fail "socket left behind after SIGTERM"
[[ ! -e "$PIDFILE" ]] || fail "PID file left behind after SIGTERM"
ok "SIGTERM shuts down cleanly and removes the socket and PID file"

start_helper
persisted="$(rpc '{"id":1,"method":"notes.count"}')"
[[ "$persisted" == *'"count":123'* ]] || fail "notes did not persist across a restart: $persisted"
rpc '{"id":1,"method":"settings.get"}' | grep -q '"escapeLosesFocus":true' || fail "settings did not persist"
[[ "$(sqlite3 "$DB" "PRAGMA journal_mode")" == "wal" ]] || fail "database is not in WAL mode"
ok "notes and settings persist across a restart (WAL database)"

rpc '{"id":1,"method":"system.shutdown"}' | grep -q '"result":{}' || fail "system.shutdown reply"
wait_exit || fail "system.shutdown should exit 0"
[[ ! -e "$SOCKET" && ! -e "$PIDFILE" ]] || fail "files left behind after system.shutdown"
ok "system.shutdown exits 0 and cleans up"

echo "[smoke] all $((PASSED + RPC_PASSED)) checks passed"
