#!/bin/bash
# Headless smoke test of the built helper binary.
#
# Starts assets/bin/BetterNotesHelper (or $HELPER) with temp directories in --headless mode,
# drives it over the Unix socket with a small Node client, checks the answers, then shuts
# it down with system.shutdown and checks that the socket and PID file are gone.
#
# Usage: scripts/smoke-helper.sh [--gui]
#   --gui  start without --headless. The panel is prewarmed but stays hidden; the check then
#          also proves WKWebView, the scheme handler, and the bridge work, because the
#          built in placeholder editor creates the first note through the bridge.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="${HELPER:-$ROOT/assets/bin/BetterNotesHelper}"
GUI_MODE=0
[[ "${1:-}" == "--gui" ]] && GUI_MODE=1
MODE_FLAG=--headless
[[ "$GUI_MODE" == "1" ]] && MODE_FLAG=""

[[ -x "$HELPER" ]] || { echo "Helper not built: run scripts/build-helper.sh first" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required for the smoke client" >&2; exit 1; }

TMP="$(mktemp -d /tmp/bn-smoke.XXXXXX)"
SUPPORT="$TMP/support"
RUN="$TMP/run"
SOCKET="$RUN/helper.sock"
PIDFILE="$RUN/helper.pid"
HELPER_PID=""

cleanup() {
  if [[ -n "$HELPER_PID" ]] && kill -0 "$HELPER_PID" 2>/dev/null; then
    kill -TERM "$HELPER_PID" 2>/dev/null || true
    sleep 0.3
    kill -KILL "$HELPER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "[smoke] version: $("$HELPER" --version)"
"$HELPER" --support-dir "$SUPPORT" --socket "$SOCKET" --pid-file "$PIDFILE" --editor-dir "$TMP/no-editor" ${MODE_FLAG:+"$MODE_FLAG"} \
  >"$TMP/stdout.log" 2>&1 &
HELPER_PID=$!

for _ in $(seq 1 50); do
  [[ -S "$SOCKET" ]] && break
  sleep 0.1
done
[[ -S "$SOCKET" ]] || { echo "[smoke] socket never appeared"; cat "$TMP/stdout.log"; exit 1; }

# Permissions from the contract.
[[ "$(stat -f %Lp "$RUN")" == "700" ]] || { echo "[smoke] socket dir is not 0700"; exit 1; }
[[ "$(stat -f %Lp "$SOCKET")" == "600" ]] || { echo "[smoke] socket is not 0600"; exit 1; }
[[ "$(cat "$PIDFILE")" == "$HELPER_PID" ]] || { echo "[smoke] PID file does not hold the helper pid"; exit 1; }

# A second instance must exit 0 right away and leave the first one running.
"$HELPER" --support-dir "$SUPPORT" --socket "$SOCKET" --pid-file "$PIDFILE" --headless
kill -0 "$HELPER_PID"

GUI_MODE="$GUI_MODE" SOCKET="$SOCKET" EXPECTED_PID="$HELPER_PID" EXPECTED_VERSION="$("$HELPER" --version)" node - <<'JS'
const net = require("node:net");
const assert = require("node:assert/strict");

const socket = net.createConnection(process.env.SOCKET);
const pending = new Map();
let buffer = "";
let nextId = 1;
socket.setEncoding("utf8");
socket.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const message = JSON.parse(line);
    const entry = pending.get(message.id);
    if (entry) { pending.delete(message.id); entry(message); }
  }
});

function request(method, params = {}, timeoutMs = 3000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    socket.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
async function call(method, params, timeoutMs) {
  const message = await request(method, params, timeoutMs);
  if (message.error) throw Object.assign(new Error(`${method}: ${message.error.message}`), { code: message.error.code });
  return message.result;
}
async function expectError(code, method, params) {
  const message = await request(method, params);
  assert.equal(message.error?.code, code, `${method} should fail with ${code}`);
}
const content = (text) => ({ rawContent: JSON.stringify({ type: "doc" }), markdown: text, text, title: text.split("\n")[0] });

(async () => {
  const ping = await call("system.ping");
  assert.equal(ping.version, process.env.EXPECTED_VERSION);
  assert.equal(String(ping.pid), process.env.EXPECTED_PID);

  let baseline = 0;
  if (process.env.GUI_MODE === "1") {
    // The hidden placeholder editor loads over betternotes:// and creates a note via the bridge.
    const deadline = Date.now() + 8000;
    while ((baseline = (await call("notes.count")).count) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(baseline, 1, "the placeholder editor did not create its note through the bridge");
    console.log("[smoke] web view, scheme handler, and bridge verified");
  }

  const a = await call("notes.create", content("Café list\nmilk"));
  const b = await call("notes.create", content("Second note"));
  assert.equal(a.caretPosition, 0);
  assert.equal(await call("notes.count").then((r) => r.count), baseline + 2);

  const updated = await call("notes.update", { id: a.id, ...content("Café list\nmilk and eggs"), expectedUpdatedAt: a.updatedAt });
  assert.equal(updated.status, "ok");
  const conflict = await call("notes.update", { id: a.id, text: "stale", expectedUpdatedAt: a.updatedAt });
  assert.equal(conflict.status, "conflict");

  const filtered = await call("notes.list", { filter: "CAFE" });
  assert.deepEqual(filtered.items.map((n) => n.id), [a.id]);
  assert.equal(filtered.items[0].charCount, "Café list\nmilk and eggs".length);

  await call("notes.pin", { id: b.id });
  const listed = await call("notes.list", { limit: 1 });
  assert.equal(listed.items[0].id, b.id);
  assert.ok(listed.nextCursor);
  const page2 = await call("notes.list", { limit: 1, cursor: listed.nextCursor });
  assert.deepEqual(page2.items.map((n) => n.id), [a.id]);
  assert.equal(page2.nextCursor === null, baseline === 0);

  await call("notes.setCurrentNote", { noteId: a.id });
  const windowData = await call("notes.windowData");
  assert.equal(windowData.current.id, a.id);
  assert.deepEqual(windowData.pinnedShortcutNoteIds, [b.id]);

  await call("notes.delete", { id: a.id });
  const deleted = await call("notes.listDeleted");
  assert.deepEqual(deleted.items.map((n) => n.id), [a.id]);
  assert.equal(deleted.items[0].markdown, "Café list\nmilk and eggs");
  await call("notes.recover", { id: a.id });

  const settings = await call("settings.set", { zoom: 1.13, countMode: "words" });
  assert.equal(settings.zoom, 1.15);
  assert.equal(settings.countMode, "words");

  await expectError(-32601, "notes.search", { query: "x" });
  await expectError(-32601, "system.ready");
  await expectError(-32602, "notes.get", {});
  await expectError(404, "notes.get", { id: "missing" });

  // Many requests in flight on one connection, answered out of order and matched by id.
  const burst = await Promise.all(Array.from({ length: 25 }, (_, i) => call("notes.create", content(`burst ${i}`))));
  assert.equal(new Set(burst.map((n) => n.id)).size, 25);

  assert.deepEqual(await call("system.shutdown", {}, 10000), {});
  console.log("[smoke] all RPC checks passed");
  socket.end();
})().catch((error) => {
  console.error("[smoke] FAILED:", error.message);
  process.exit(1);
});
JS

for _ in $(seq 1 50); do
  kill -0 "$HELPER_PID" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$HELPER_PID" 2>/dev/null; then
  echo "[smoke] helper did not exit after system.shutdown"; exit 1
fi
wait "$HELPER_PID" && status=0 || status=$?
[[ "$status" == "0" ]] || { echo "[smoke] helper exited with $status"; exit 1; }
[[ ! -e "$SOCKET" ]] || { echo "[smoke] socket left behind"; exit 1; }
[[ ! -e "$PIDFILE" ]] || { echo "[smoke] PID file left behind"; exit 1; }
[[ -s "$SUPPORT/notes.sqlite" ]] || { echo "[smoke] database missing"; exit 1; }
HELPER_PID=""
echo "[smoke] clean shutdown verified"
