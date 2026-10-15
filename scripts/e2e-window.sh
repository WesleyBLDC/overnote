#!/bin/bash
# End to end check of the panel's window behavior (spec/window.md) against the real helper.
#
# Starts the helper in GUI mode with --test-hooks and temp directories, then drives it over
# its socket. Window state comes from two independent sources: the helper's own view
# (test.windowState) and the window server, read by a separate probe process
# (helper/Tools/window-probe.swift) for this helper's pid only.
#
# The panel is visible for only a few seconds in total, and the script never synthesizes
# mouse or keyboard input, so it is safe to run while someone works on the machine.
# With --capture <file.png> it also saves a picture of the helper's own window, by window id.
#
# Checks: three way toggle, no app activation, key status and first responder, modal panel
# level, all Spaces plus full screen auxiliary, no first mouse, height clamping (128 to 860
# scaled by zoom, 2 pt tolerance, top edge fixed), the ⌘K/⌘P minimum height and its
# restore, the user height rule, per display position memory, and persistence across a restart.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="${HELPER:-$ROOT/assets/bin/BetterNotesHelper}"
CAPTURE=""
[[ "${1:-}" == "--capture" ]] && CAPTURE="${2:?--capture needs a file path}"

[[ -x "$HELPER" ]] || { echo "Helper not built: run scripts/build-helper.sh first" >&2; exit 1; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

PROBE_DIR="$ROOT/helper/.build/tools"
PROBE="$PROBE_DIR/window-probe"
PROBE_SRC="$ROOT/helper/Tools/window-probe.swift"
if [[ ! -x "$PROBE" || "$PROBE_SRC" -nt "$PROBE" ]]; then
  mkdir -p "$PROBE_DIR"
  swiftc -O "$PROBE_SRC" -o "$PROBE"
fi

TMP="$(mktemp -d /tmp/bn-e2e.XXXXXX)"
trap 'pkill -TERM -f "$TMP/support" 2>/dev/null || true; rm -rf "$TMP"' EXIT

EDITOR_DIR="$ROOT/assets/editor"
[[ -f "$EDITOR_DIR/index.html" ]] || { echo "Editor not built: assets/editor/index.html is missing" >&2; exit 1; }

HELPER="$HELPER" PROBE="$PROBE" TMP="$TMP" CAPTURE="$CAPTURE" EDITOR_DIR="$EDITOR_DIR" node - <<'JS'
const net = require("node:net");
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");

const { HELPER, PROBE, TMP, CAPTURE, EDITOR_DIR } = process.env;
const socketPath = `${TMP}/run/helper.sock`;
const argsFor = (support, editorDir) => ["--support-dir", support, "--socket", socketPath,
  "--pid-file", `${TMP}/run/helper.pid`, "--editor-dir", editorDir, "--test-hooks"];
// The window mechanics run on the built in placeholder editor, which reports its height
// once and then stays quiet; the real editor gets its own phase at the end.
let args = argsFor(`${TMP}/support`, `${TMP}/no-editor`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let visibleSince = 0;
let visibleTotal = 0;
const results = [];
const check = (name, fn) => {
  try { fn(); } catch (error) { error.message = `${name}: ${error.message}`; throw error; }
  results.push(name);
};

function connect() {
  const socket = net.createConnection(socketPath);
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
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 3000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result);
    });
    socket.write(JSON.stringify({ id, method, params }) + "\n");
  });
  return { socket, call };
}

async function start() {
  const child = spawn(HELPER, args, { stdio: "ignore" });
  for (let i = 0; i < 80 && !fs.existsSync(socketPath); i++) await sleep(50);
  assert.ok(fs.existsSync(socketPath), "socket never appeared");
  return { child, ...connect() };
}

async function stop(helper) {
  if (visibleSince) { visibleTotal += Date.now() - visibleSince; visibleSince = 0; }
  await helper.call("system.shutdown");
  await new Promise((resolve) => helper.child.on("exit", resolve));
  helper.socket.destroy();
}

const probeWindows = (pid) => JSON.parse(execFileSync(PROBE, ["windows", String(pid)], { encoding: "utf8" }));
const frontmostPid = () => Number(execFileSync(PROBE, ["frontmost"], { encoding: "utf8" }).trim());
const panelWindow = (pid, state) =>
  probeWindows(pid).find((w) => Math.abs(w.width - state.frame.width) < 1 && Math.abs(w.height - state.frame.height) < 1);

(async () => {
  let helper = await start();
  const { call } = helper;
  const pid = helper.child.pid;
  const state = () => call("test.windowState");
  const bridge = (method, params = {}) => call("test.asBridge", { method, params });
  const toggle = async () => {
    const result = await call("window.toggle");
    if (result.visible && !visibleSince) visibleSince = Date.now();
    if (!result.visible && visibleSince) { visibleTotal += Date.now() - visibleSince; visibleSince = 0; }
    return result;
  };

  // Prewarmed and hidden: the placeholder editor loads and creates its first note via the bridge.
  for (let i = 0; i < 100 && (await call("notes.count")).count === 0; i++) await sleep(50);
  let s = await state();
  check("prewarmed hidden panel", () => {
    assert.equal(s.visible, false);
    assert.equal((s.frame.width > 0), true);
  });
  const frontBefore = frontmostPid();

  // Hidden → show and key, without activating the app.
  const t0 = process.hrtime.bigint();
  assert.equal((await toggle()).visible, true);
  const showMs = Number(process.hrtime.bigint() - t0) / 1e6;
  await sleep(150);
  s = await state();
  check("show makes the panel key without activating the app", () => {
    assert.equal(s.visible, true);
    assert.equal(s.key, true);
    // NSApp.isActive reads true while a non activating panel holds key focus; what matters
    // to the user is that the frontmost app (and its menu bar) never changes.
    assert.equal(s.firstResponderIsWebView, true);
    assert.notEqual(frontmostPid(), pid);
    assert.equal(frontmostPid(), frontBefore);
  });
  check("window kind: modal panel level, all Spaces, full screen auxiliary, no first mouse", () => {
    assert.equal(s.level, s.modalPanelLevel);
    assert.equal(s.canJoinAllSpaces, true);
    assert.equal(s.fullScreenAuxiliary, true);
    assert.equal(s.nonactivating, true);
    assert.equal(s.resizable, true);
    assert.equal(s.hidesOnDeactivate, false);
    assert.equal(s.acceptsFirstMouse, false);
    const server = panelWindow(pid, s);
    assert.ok(server, "window server does not list the panel");
    assert.equal(server.layer, 8, "window server layer should be the modal panel layer (8)");
    assert.equal(server.onscreen, true);
    assert.equal(server.sharing, 1, "shareable (read only) by default");
  });

  // Height: 128 to 860 at 100%, scaled by zoom, top edge fixed, 2 pt tolerance.
  const top = s.frame.top;
  const height = async (contentHeight) => {
    await bridge("window.resize", { contentHeight });
    return (await state()).frame;
  };
  let f = await height(50);
  check("auto-height minimum 128", () => { assert.equal(f.height, 128); assert.equal(f.top, top); });
  f = await height(300);
  check("auto-height follows content with the top edge fixed", () => { assert.equal(f.height, 300); assert.equal(f.top, top); });
  f = await height(302);
  check("changes of 2 pt or less are ignored", () => assert.equal(f.height, 300));
  f = await height(5000);
  const maxAt100 = Math.min(860, s.visibleFrameHeight);
  check("auto-height maximum 860 (or the display)", () => assert.equal(f.height, Math.floor(maxAt100)));
  await call("settings.set", { zoom: 1.5 });
  f = await height(50);
  check("limits scale with zoom (128 x 1.5 = 192)", () => assert.equal(f.height, 192));
  await call("settings.set", { zoom: 1 });
  f = await height(140);
  assert.equal(f.height, 140);

  // While ⌘K or ⌘P is open the editor reports a taller content height, then restores it.
  // Those reports are programmatic: they never turn auto-sizing off.
  const grown = await height(442);
  const restored = await height(140);
  check("temporary growth to 442 and back keeps auto-sizing on", () => {
    assert.equal(grown.height, 442);
    assert.equal(grown.top, top);
    assert.equal(restored.height, 140);
  });
  assert.equal((await call("settings.get")).windowAutoSize, true);

  const menu = await call("test.editMenu");
  const byKeys = Object.fromEntries(menu.map((item) => [item.keys, item.action]));
  check("Edit menu: ⌘C ⌘X ⌘V ⌘Z ⇧⌘Z ⌘A, and ⇧⌘V sends a real paste", () => {
    assert.equal(byKeys["⌘C"], "copy:");
    assert.equal(byKeys["⌘X"], "cut:");
    assert.equal(byKeys["⌘V"], "paste:");
    assert.equal(byKeys["⌘Z"], "undo:");
    assert.equal(byKeys["⇧⌘Z"], "redo:");
    assert.equal(byKeys["⌘A"], "selectAll:");
    assert.equal(byKeys["⇧⌘V"], "paste:");
  });

  // Three way toggle.
  await call("test.resignKey");
  await sleep(250);
  const notKey = await state();
  if (notKey.visible && !notKey.key) {
    assert.equal((await toggle()).visible, true);
    await sleep(100);
    s = await state();
    check("toggle on a visible, unfocused panel focuses it without hiding", () => {
      assert.equal(s.visible, true);
      assert.equal(s.key, true);
    });
    await call("test.dropDecoy");
  } else {
    console.log("[e2e] note: could not take key focus away without input; skipped the focus-only toggle case");
  }
  assert.equal((await toggle()).visible, false);
  s = await state();
  check("toggle on a visible, key panel hides it", () => assert.equal(s.visible, false));
  assert.equal((await toggle()).visible, true);
  await sleep(100);

  // A user height change turns auto-sizing off; a width only change does not.
  s = await state();
  await call("test.simulateUserResize", { height: s.frame.height, width: 640 });
  let settings = await call("settings.get");
  check("width only resize keeps auto-sizing on", () => {
    assert.equal(settings.windowAutoSize, true);
    assert.equal(settings.panelFrame.width, 640);
  });
  await call("test.simulateUserResize", { height: 500 });
  settings = await call("settings.get");
  const events = await call("test.events");
  f = await height(200);
  check("user height change turns auto-sizing off and keeps the height", () => {
    assert.equal(settings.windowAutoSize, false);
    assert.equal(settings.panelFrame.height, 500);
    assert.ok(events.some((e) => e.event === "settings.changed" && e.payload.windowAutoSize === false));
    assert.equal(f.height, 500);
  });

  // Per display position memory.
  s = await state();
  const target = { x: Math.round(s.frame.x) - 40, top: Math.round(s.frame.top) - 30 };
  await call("test.moveTo", target);
  assert.equal((await toggle()).visible, false);
  settings = await call("settings.get");
  check("hide remembers the top left point for this display", () => {
    const point = settings.panelFrame.displays[s.screenKey];
    assert.deepEqual(point, { x: target.x, y: target.top });
  });
  assert.equal((await toggle()).visible, true);
  await sleep(100);
  s = await state();
  check("show reopens at the remembered point", () => {
    assert.equal(s.frame.x, target.x);
    assert.equal(s.frame.top, target.top);
  });

  if (CAPTURE) {
    const server = panelWindow(pid, s);
    execFileSync("screencapture", ["-x", "-o", "-l", String(server.id), CAPTURE]);
    console.log(`[e2e] captured the panel window to ${CAPTURE}`);
  }
  await stop(helper);

  // Size and position survive a restart.
  helper = await start();
  await helper.call("window.show");
  visibleSince = Date.now();
  await sleep(200);
  const after = await helper.call("test.windowState");
  check("size and per display position survive a restart", () => {
    assert.equal(after.frame.x, target.x);
    assert.equal(after.frame.top, target.top);
    assert.equal(after.frame.width, 640);
    assert.equal(after.frame.height, 500);
  });
  await stop(helper);

  // The real editor build: served over betternotes:// (strict CSP, lazy chunks), it must
  // reach system.ready and report its height, and the panel must follow that height.
  args = argsFor(`${TMP}/support-editor`, EDITOR_DIR);
  helper = await start();
  let calls = { methods: [], resizes: [] };
  for (let i = 0; i < 160 && !calls.methods.includes("system.ready"); i++) {
    calls = await helper.call("test.bridgeCalls");
    if (!calls.methods.includes("system.ready")) await sleep(50);
  }
  check("real editor loads hidden and calls system.ready", () => {
    assert.ok(calls.methods.includes("system.ready"), `bridge calls: ${calls.methods.join(", ")}`);
  });
  // The editor measures in requestAnimationFrame, which WebKit pauses in hidden windows,
  // so its first height report arrives once the panel is visible.
  await helper.call("window.show");
  visibleSince = Date.now();
  for (let i = 0; i < 60; i++) {
    calls = await helper.call("test.bridgeCalls");
    if (calls.resizes.length > 0) break;
    await sleep(25);
  }
  await sleep(150);
  calls = await helper.call("test.bridgeCalls");
  const shownEditor = await helper.call("test.windowState");
  const reported = calls.resizes.at(-1);
  check("real editor reports window.resize once visible", () => assert.ok(reported > 0, "no window.resize"));
  const expected = Math.min(Math.max(Math.ceil(reported), 128), Math.floor(Math.min(860, shownEditor.visibleFrameHeight)));
  check("the panel height follows the real editor's report", () => {
    assert.ok(Math.abs(shownEditor.frame.height - expected) <= 2, `height ${shownEditor.frame.height}, expected ${expected}`);
  });
  if (CAPTURE) {
    const server = panelWindow(helper.child.pid, shownEditor);
    const editorCapture = CAPTURE.replace(/(\.png)?$/, "-editor.png");
    execFileSync("screencapture", ["-x", "-o", "-l", String(server.id), editorCapture]);
    console.log(`[e2e] captured the real editor panel to ${editorCapture}`);
  }
  await stop(helper);
  const log = fs.readFileSync(`${TMP}/support-editor/helper.log`, "utf8");
  check("every editor asset was served (no 404s)", () => assert.ok(!log.includes("asset not found"), log));

  for (const name of results) console.log(`[e2e] ok  ${name}`);
  console.log(`[e2e] warm show round trip ${showMs.toFixed(1)} ms; panel visible ${(visibleTotal / 1000).toFixed(1)} s in total`);
  console.log(`[e2e] ${results.length} window checks passed`);
})().catch((error) => {
  console.error("[e2e] FAILED:", error.message);
  process.exit(1);
});
JS
