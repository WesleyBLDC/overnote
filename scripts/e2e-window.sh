#!/bin/bash
# End to end check of the panel's window behavior against the real helper.
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
# Checks: the 640 x 560 first open (auto-sizing off by default), three way toggle, no app
# activation, key status and first responder, modal panel level, all Spaces plus full screen
# auxiliary, the dark material under a transparent web view, height clamping (128 to 860
# scaled by zoom, 2 pt tolerance, top edge fixed), temporary growth that only grows, the user
# height rule, editor drag regions and the drag strip, first mouse, resize hit zones and real
# resize drags, ⌘W, per display position memory, and persistence across a restart.
#
# Mouse and key events in the drag, resize, and ⌘W checks are built with NSEvent inside the
# helper and dispatched through its own NSApp.sendEvent and event queue (test hooks). They
# never reach the window server, so they cannot touch other apps or the real pointer.
#
# Timing: nothing waits a fixed time. Every asynchronous effect (the first launch of the web
# content process, key status, the window server, page events, editor reports) is awaited as
# a condition with a timeout, and every assertion carries the name of its check. A failure
# prints that name, the script line, and a snapshot of the window state.
#
# Environment:
#   HELPER            helper binary (default assets/bin/OvernoteHelper)
#   OVERNOTE_LOG_DIR  on failure, copy the helper logs here (CI uploads this folder)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="${HELPER:-$ROOT/assets/bin/OvernoteHelper}"
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

EDITOR_DIR="$ROOT/assets/editor"
[[ -f "$EDITOR_DIR/index.html" ]] || { echo "Editor not built: assets/editor/index.html is missing" >&2; exit 1; }

TMP="$(mktemp -d /tmp/overnote-e2e.XXXXXX)"
finish() {
  local status=$?
  pkill -TERM -f "$TMP/support" 2>/dev/null || true
  if [[ $status -ne 0 ]]; then
    for log in "$TMP"/support*/helper.log; do
      [[ -f "$log" ]] || continue
      echo "[e2e] last lines of $(basename "$(dirname "$log")")/helper.log:" >&2
      tail -n 20 "$log" >&2
      if [[ -n "${OVERNOTE_LOG_DIR:-}" ]]; then
        mkdir -p "$OVERNOTE_LOG_DIR/e2e-window"
        cp "$log" "$OVERNOTE_LOG_DIR/e2e-window/$(basename "$(dirname "$log")").log"
      fi
    done
  fi
  rm -rf "$TMP"
}
trap finish EXIT

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
// while it loads and then stays quiet; the real editor gets its own phase at the end.
let args = argsFor(`${TMP}/support`, `${TMP}/no-editor`);

// Timeouts only matter when something is wrong: a healthy run never waits for them. The
// first launch of a freshly built binary is the slow case (code signature assessment and
// the first WebKit content process), so startup and page loads get the most room.
const STARTUP_MS = 20_000;
const PAGE_LOAD_MS = 30_000;
const UI_MS = 5_000;
const RPC_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let visibleSince = 0;
let visibleTotal = 0;
let passed = 0;
let currentStep = "starting the helper";
let lastState = null;

/** Runs one named check; any failure inside it carries the name. */
const check = async (name, fn) => {
  currentStep = name;
  try { await fn(); } catch (error) { error.message = `${name}: ${error.message}`; error.checkFailed = true; throw error; }
  passed++;
  console.log(`[e2e] ok  ${name}`);
};

/** Polls `get` until `ok(value)` holds or the timeout passes, and returns the last value either way. */
async function poll(get, ok, ms = UI_MS, interval = 25) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await get();
    if (ok(value) || Date.now() >= deadline) return value;
    await sleep(interval);
  }
}

/** Like poll, but a timeout is a failure of the named condition. */
async function until(name, get, ok, ms = UI_MS) {
  currentStep = name;
  const value = await poll(get, ok, ms);
  if (!ok(value)) throw new Error(`${name}: not reached within ${ms} ms (last value ${JSON.stringify(value)})`);
  return value;
}

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
  socket.on("error", (error) => {
    for (const settle of pending.values()) settle({ error: { message: `socket error: ${error.message}` } });
    pending.clear();
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout after ${RPC_MS} ms: ${method}`)); }, RPC_MS);
    pending.set(id, (message) => {
      clearTimeout(timer);
      message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result);
    });
    socket.write(JSON.stringify({ id, method, params }) + "\n");
  });
  const connected = new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return { socket, call, connected };
}

let helper = null;

async function start() {
  const child = spawn(HELPER, args, { stdio: "ignore" });
  let exited = null;
  child.on("exit", (code, signal) => { exited = { code, signal }; });
  // Wait for this process to answer, not just for a socket file.
  const deadline = Date.now() + STARTUP_MS;
  for (;;) {
    currentStep = "helper starts and answers system.ping";
    if (exited) throw new Error(`${currentStep}: the helper exited early (${JSON.stringify(exited)})`);
    if (fs.existsSync(socketPath)) {
      const client = connect();
      try {
        await client.connected;
        const ping = await client.call("system.ping");
        if (ping.pid === child.pid) return { child, exited: () => exited, ...client };
      } catch {
        // Not listening yet; try again.
      }
      client.socket.destroy();
    }
    if (Date.now() >= deadline) throw new Error(`${currentStep}: no answer within ${STARTUP_MS} ms`);
    await sleep(50);
  }
}

async function stop(target) {
  if (visibleSince) { visibleTotal += Date.now() - visibleSince; visibleSince = 0; }
  currentStep = "system.shutdown exits the helper";
  const exit = new Promise((resolve) => target.exited() ? resolve() : target.child.on("exit", resolve));
  await target.call("system.shutdown");
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${currentStep}: still running after ${STARTUP_MS} ms`)), STARTUP_MS);
  });
  try { await Promise.race([exit, timeout]); } finally { clearTimeout(timer); }
  target.socket.destroy();
}

const probeWindows = (pid) => JSON.parse(execFileSync(PROBE, ["windows", String(pid)], { encoding: "utf8" }));
const frontmostPid = () => Number(execFileSync(PROBE, ["frontmost"], { encoding: "utf8" }).trim());
const panelWindow = (pid, state) =>
  probeWindows(pid).find((w) => Math.abs(w.width - state.frame.width) < 1 && Math.abs(w.height - state.frame.height) < 1);

/** Mouse downs the page saw, as rounded client x positions, in arrival order. */
const pageDownsSetup = "(window.__bnDowns = [], document.addEventListener('mousedown', (e) => window.__bnDowns.push(Math.round(e.clientX)), true), 0)";
const near = (x) => (value) => Math.abs(value - x) <= 1;

(async () => {
  helper = await start();
  const { call } = helper;
  const pid = helper.child.pid;
  const state = async () => (lastState = await call("test.windowState"));
  const bridge = (method, params = {}) => call("test.asBridge", { method, params });
  const bridgeCalls = () => call("test.bridgeCalls");
  const markVisible = (visible) => {
    if (visible && !visibleSince) visibleSince = Date.now();
    if (!visible && visibleSince) { visibleTotal += Date.now() - visibleSince; visibleSince = 0; }
  };
  const toggle = async () => {
    const result = await call("window.toggle");
    markVisible(result.visible);
    return result;
  };
  const js = (expression) => call("test.js", { expression });
  const shownAndKey = (st) => st.visible && st.key;
  /** Takes key status away with the decoy window; returns false when AppKit would not let it go. */
  const resignKey = async () => {
    await call("test.resignKey");
    return !(await poll(state, (st) => !st.key, 2_000)).key;
  };

  // Prewarmed and hidden: the placeholder editor loads, creates its first note through the
  // bridge, and reports its height. The first launch of a fresh build can take seconds here,
  // and a late height report would land in the middle of the height checks, so wait until
  // the page has finished its startup calls and gone quiet.
  await until("placeholder editor finishes loading (notes.setCurrentNote)", bridgeCalls,
    (calls) => calls.methods.includes("notes.setCurrentNote"), PAGE_LOAD_MS);
  let quietSince = Date.now();
  let lastCount = -1;
  await until("placeholder editor goes quiet (no bridge calls for 300 ms)", async () => {
    const count = (await bridgeCalls()).methods.length;
    if (count !== lastCount) { lastCount = count; quietSince = Date.now(); }
    return Date.now() - quietSince;
  }, (quietFor) => quietFor >= 300, UI_MS);
  let s = await state();
  const noteCount = (await call("notes.count")).count;
  await check("prewarmed hidden panel with the placeholder's first note", () => {
    assert.equal(s.visible, false, "visible");
    assert.ok(s.frame.width > 0, `frame width ${s.frame.width}`);
    assert.equal(noteCount, 1, "note count");
  });
  const frontBefore = frontmostPid();

  // Hidden → show and key, without activating the app.
  const t0 = process.hrtime.bigint();
  const firstToggle = await toggle();
  const showMs = Number(process.hrtime.bigint() - t0) / 1e6;
  s = await poll(state, (st) => shownAndKey(st) && st.firstResponderIsWebView);
  await check("show makes the panel key without activating the app", () => {
    assert.equal(firstToggle.visible, true, "window.toggle result");
    assert.equal(s.visible, true, "visible");
    assert.equal(s.key, true, "key");
    // NSApp.isActive reads true while a non activating panel holds key focus; what matters
    // to the user is that the frontmost app (and its menu bar) never changes.
    assert.equal(s.firstResponderIsWebView, true, "first responder is the web view");
    assert.notEqual(frontmostPid(), pid, "frontmost app is the helper");
    assert.equal(frontmostPid(), frontBefore, "frontmost app changed");
  });
  // The window server learns about the new window asynchronously.
  const server = await poll(() => panelWindow(pid, s), (w) => w?.onscreen === true);
  await check("window kind: modal panel level, all Spaces, full screen auxiliary, no first mouse", () => {
    assert.equal(s.level, s.modalPanelLevel, "level");
    assert.equal(s.canJoinAllSpaces, true, "canJoinAllSpaces");
    assert.equal(s.fullScreenAuxiliary, true, "fullScreenAuxiliary");
    assert.equal(s.nonactivating, true, "nonactivating");
    assert.equal(s.resizeZones, true, "resize zones");
    assert.equal(s.hidesOnDeactivate, false, "hidesOnDeactivate");
    assert.equal(s.acceptsFirstMouse, false, "acceptsFirstMouse");
    assert.ok(server, "window server does not list the panel");
    assert.equal(server.layer, 8, "window server layer should be the modal panel layer (8)");
    assert.equal(server.onscreen, true, "window server onscreen");
    assert.equal(server.sharing, 1, "shareable (read only) by default");
  });
  await check("first open: 640 x 560, centered, top just under the menu bar, on the pointer's display", () => {
    const vf = s.visibleFrame;
    assert.equal(s.frame.width, 640, "width");
    assert.equal(s.frame.height, 560, "height");
    assert.ok(Math.abs(s.frame.x - (vf.x + vf.width / 2 - 320)) <= 1, `x ${s.frame.x}, visible ${JSON.stringify(vf)}`);
    assert.equal(s.frame.top, vf.y + vf.height, "top");
    assert.equal(s.screenKey, s.pointerScreenKey, "panel display vs pointer display");
  });
  const defaultsBefore = await call("settings.get");
  await check("auto-sizing is off by default, so the placeholder's height report keeps 560", () => {
    assert.equal(defaultsBefore.windowAutoSize, false, "windowAutoSize");
    assert.equal(defaultsBefore.panelFrame, null, "panelFrame");
  });
  await check("dark vibrancy material (HUD, active) under a transparent web view", () => {
    assert.equal(s.material, s.hudWindowMaterial, "material");
    assert.equal(s.materialActive, true, "material active");
    assert.equal(s.webViewDrawsBackground, false, "web view draws background");
  });
  // The height mechanics below run with auto-sizing on. settings.set replies after the
  // panel has applied the new settings, so no wait is needed after it.
  await call("settings.set", { windowAutoSize: true });

  // Height: 128 to 860 at 100%, scaled by zoom, top edge fixed, 2 pt tolerance.
  const top = s.frame.top;
  const height = async (contentHeight) => {
    await bridge("window.resize", { contentHeight });
    return (await state()).frame;
  };
  let f = await height(50);
  await check("auto-height minimum 128", () => { assert.equal(f.height, 128, "height"); assert.equal(f.top, top, "top"); });
  f = await height(300);
  await check("auto-height follows content with the top edge fixed", () => {
    assert.equal(f.height, 300, "height");
    assert.equal(f.top, top, "top");
  });
  f = await height(302);
  await check("changes of 2 pt or less are ignored", () => assert.equal(f.height, 300, "height"));
  f = await height(5000);
  const maxAt100 = Math.min(860, s.visibleFrameHeight);
  await check("auto-height maximum 860 (or the display)", () => assert.equal(f.height, Math.floor(maxAt100), "height"));
  await call("settings.set", { zoom: 1.5 });
  f = await height(50);
  await check("limits scale with zoom (128 x 1.5 = 192)", () => assert.equal(f.height, 192, "height"));
  await call("settings.set", { zoom: 1 });
  f = await height(140);
  await check("back at 100% zoom, a 140 pt report gives 140", () => assert.equal(f.height, 140, "height"));

  // While ⌘K, browse, or a dialog is open the editor sends a temporary taller report, then a
  // normal one. Reports are programmatic: they never turn auto-sizing off.
  await bridge("window.resize", { contentHeight: 442, temporary: true });
  const grown = (await state()).frame;
  const restored = await height(140);
  const autoAfterTemporary = (await call("settings.get")).windowAutoSize;
  await check("auto-sizing on: a temporary report grows to 442 and the next normal report restores", () => {
    assert.equal(grown.height, 442, "grown height");
    assert.equal(grown.top, top, "grown top");
    assert.equal(restored.height, 140, "restored height");
    assert.equal(autoAfterTemporary, true, "windowAutoSize after programmatic reports");
  });

  // Temporary growth only grows: a panel already taller than the request stays as it is.
  await height(600);
  await bridge("window.resize", { contentHeight: 442, temporary: true });
  const tallTemp = (await state()).frame;
  const tallAfter = await height(600);
  await check("auto-sizing on: a temporary report on a taller panel changes nothing", () => {
    assert.equal(tallTemp.height, 600, "temporary height");
    assert.equal(tallTemp.top, top, "top");
    assert.equal(tallAfter.height, 600, "height after");
  });
  await height(140);

  const menuItems = await call("test.menuItems");
  const menu = menuItems.filter((item) => item.menu === "Edit");
  const byKeys = Object.fromEntries(menu.map((item) => [item.keys, item.action]));
  const closeItem = menuItems.find((item) => item.keys === "⌘W");
  await check("File menu: Close Window ⌘W targets the panel's hide path", () => {
    assert.ok(closeItem, JSON.stringify(menuItems));
    assert.equal(closeItem.title, "Close Window", "title");
    assert.equal(closeItem.action, "closeWindow:", "action");
    assert.equal(closeItem.hasTarget, true, "has target");
  });
  await check("Edit menu: ⌘C ⌘X ⌘V ⌘Z ⇧⌘Z ⌘A, and ⇧⌘V sends a real paste", () => {
    assert.equal(byKeys["⌘C"], "copy:");
    assert.equal(byKeys["⌘X"], "cut:");
    assert.equal(byKeys["⌘V"], "paste:");
    assert.equal(byKeys["⌘Z"], "undo:");
    assert.equal(byKeys["⇧⌘Z"], "redo:");
    assert.equal(byKeys["⌘A"], "selectAll:");
    assert.equal(byKeys["⇧⌘V"], "paste:");
  });

  // Three way toggle.
  if (await resignKey()) {
    const focusToggle = await toggle();
    s = await poll(state, shownAndKey);
    await check("toggle on a visible, unfocused panel focuses it without hiding", () => {
      assert.equal(focusToggle.visible, true, "window.toggle result");
      assert.equal(s.visible, true, "visible");
      assert.equal(s.key, true, "key");
    });
    await call("test.dropDecoy");
  } else {
    await call("test.dropDecoy");
    console.log("[e2e] note: could not take key focus away without input; skipped the focus-only toggle case");
  }
  // The hide case needs a key panel; give AppKit its moment after the decoy goes away.
  const keyBeforeHide = (await poll(state, shownAndKey)).key;
  const hideToggle = await toggle();
  s = await state();
  await check("toggle on a visible, key panel hides it", () => {
    assert.equal(keyBeforeHide, true, "panel was key before the toggle");
    assert.equal(hideToggle.visible, false, "window.toggle result");
    assert.equal(s.visible, false, "visible");
  });
  const showToggle = await toggle();
  s = await poll(state, shownAndKey);
  await check("toggle on a hidden panel shows it again", () => {
    assert.equal(showToggle.visible, true, "window.toggle result");
    assert.equal(s.visible && s.key, true, "visible and key");
  });

  // A user height change turns auto-sizing off; a width only change does not.
  await call("test.simulateUserResize", { height: s.frame.height, width: 700 });
  let settings = await call("settings.get");
  await check("width only resize keeps auto-sizing on", () => {
    assert.equal(settings.windowAutoSize, true, "windowAutoSize");
    assert.equal(settings.panelFrame.width, 700, "stored width");
  });
  await call("test.simulateUserResize", { height: 500 });
  settings = await call("settings.get");
  const events = await call("test.events");
  f = await height(200);
  await check("user height change turns auto-sizing off and keeps the height", () => {
    assert.equal(settings.windowAutoSize, false, "windowAutoSize");
    assert.equal(settings.panelFrame.height, 500, "stored height");
    assert.ok(events.some((e) => e.event === "settings.changed" && e.payload.windowAutoSize === false), "settings.changed event");
    assert.equal(f.height, 500, "height after a content report");
  });
  await bridge("window.resize", { contentHeight: 442, temporary: true });
  const tallEnough = (await state()).frame;
  const keptUserHeight = await height(200);
  await check("auto-sizing off: a temporary report on a 500 pt panel is a no-op, and the next report keeps 500", () => {
    assert.equal(tallEnough.height, 500, "temporary height");
    assert.equal(keptUserHeight.height, 500, "height after");
    assert.equal(keptUserHeight.top, tallEnough.top, "top");
  });

  // With auto-sizing off, a temporary report still grows the panel, and the next normal
  // report restores the user's stored height (not the content height).
  await call("test.simulateUserResize", { height: 300 });
  await bridge("window.resize", { contentHeight: 442, temporary: true });
  const grownOff = (await state()).frame;
  const storedDuringGrowth = (await call("settings.get")).panelFrame.height;
  const restoredOff = await height(200);
  const autoStillOff = (await call("settings.get")).windowAutoSize;
  await check("auto-sizing off: a temporary report grows to 442 and the next normal report restores the user's height", () => {
    assert.equal(grownOff.height, 442, "grown height");
    assert.equal(storedDuringGrowth, 300, "stored height during growth");
    assert.equal(restoredOff.height, 300, "restored height");
    assert.equal(autoStillOff, false, "windowAutoSize");
  });

  // Drag regions: a mouse down inside one drags the panel; anywhere else reaches the page.
  // Page events arrive asynchronously but in order, so "never reaches the page" is proven by
  // a later click that does reach it: once that one is in, an earlier one would be too.
  await check("window.setDragRegions validates its rects", async () => {
    await assert.rejects(bridge("window.setDragRegions", { rects: "toolbar" }), /rects must be an array/);
    await assert.rejects(bridge("window.setDragRegions", { rects: [{ x: 0, y: 0, width: -1, height: 4 }] }), /negative/);
  });
  await bridge("window.setDragRegions", { rects: [{ x: 100, y: 14, width: 200, height: 30 }] });
  s = await state();
  await check("window.setDragRegions stores the rects", () =>
    assert.deepEqual(s.dragRects, [{ x: 100, y: 14, width: 200, height: 30 }]));
  await js(pageDownsSetup);
  const downs = () => js("window.__bnDowns");
  const dragClick = await call("test.mouseDown", { x: 150, y: 25 });
  const pageClick = await call("test.mouseDown", { x: 50, y: 25 });
  let seen = await poll(downs, (list) => list.some(near(50)));
  await check("a mouse down in a drag region drags the window and never reaches the page", () => {
    assert.equal(dragClick.drags, 1, "drags");
    assert.ok(seen.some(near(50)), `the later click outside the regions never arrived: ${JSON.stringify(seen)}`);
    assert.equal(seen.filter(near(150)).length, 0, `page saw ${JSON.stringify(seen)}`);
  });
  await check("a mouse down outside the drag regions reaches the page (toolbar buttons still click)", () => {
    assert.equal(pageClick.drags, 0, "drags");
    assert.equal(seen.filter(near(50)).length, 1, `page saw ${JSON.stringify(seen)}`);
  });
  const stripClick = await call("test.mouseDown", { x: 350, y: 10 });
  await check("the 12 pt top strip still drags as a fallback", () => assert.equal(stripClick.drags, 1, "drags"));
  if (await resignKey()) {
    const firstClick = await call("test.mouseDown", { x: 60, y: 25 });
    // Now key: this click reaches the page, and proves the first one did not.
    const barrierClick = await call("test.mouseDown", { x: 70, y: 25 });
    seen = await poll(downs, (list) => list.some(near(70)));
    await check("first click into an unfocused panel only focuses it (no first mouse on the page)", () => {
      assert.equal(firstClick.key, true, "key after the first click");
      assert.equal(firstClick.drags, 0, "drags");
      assert.equal(barrierClick.drags, 0, "barrier drags");
      assert.ok(seen.some(near(70)), `the focused click never arrived: ${JSON.stringify(seen)}`);
      assert.equal(seen.filter(near(60)).length, 0, `page saw ${JSON.stringify(seen)}`);
    });
    await call("test.dropDecoy");
    if (await resignKey()) {
      const unfocusedDrag = await call("test.mouseDown", { x: 150, y: 25 });
      await check("a drag region drags even an unfocused panel, like a title bar", () =>
        assert.equal(unfocusedDrag.drags, 1, "drags"));
    } else {
      console.log("[e2e] note: could not take key focus away a second time; skipped the unfocused drag check");
    }
    await call("test.dropDecoy");
  } else {
    await call("test.dropDecoy");
    console.log("[e2e] note: could not take key focus away; skipped the first mouse checks");
  }
  await poll(state, shownAndKey);
  await bridge("window.setDragRegions", { rects: [] });
  const clearedClick = await call("test.mouseDown", { x: 150, y: 25 });
  seen = await poll(downs, (list) => list.some(near(150)));
  await check("clearing the drag regions gives that area back to the page", () => {
    assert.equal(clearedClick.drags, 0, "drags");
    assert.ok(seen.some(near(150)), `page saw ${JSON.stringify(seen)}`);
  });

  // Resize zones: 8 pt along each edge, 16 pt squares at the corners, above the web view.
  s = await state();
  const w = s.frame.width, h = s.frame.height;
  const hit = (x, y) => call("test.hitTest", { x, y });
  const zones = {};
  for (const [name, x, y] of [["tl", 2, 2], ["tl-inner", 14, 14], ["tr", w - 2, 2], ["bl", 2, h - 2], ["br", w - 2, h - 2],
    ["top", w / 2, 3], ["bottom", w / 2, h - 3], ["left", 3, h / 2], ["right", w - 3, h / 2], ["left-inner", 12, h / 2],
    ["strip", w / 2, 10], ["body", w / 2, h / 2]]) {
    zones[name] = await hit(x, y);
  }
  await check("resize hit zones: edges 8 pt, corners 16 pt, interior falls through to the web view and drag strip", () => {
    assert.equal(zones.tl.zone, "top-left");
    assert.equal(zones["tl-inner"].zone, "top-left");
    assert.equal(zones.tr.zone, "top-right");
    assert.equal(zones.bl.zone, "bottom-left");
    assert.equal(zones.br.zone, "bottom-right");
    assert.equal(zones.top.zone, "top");
    assert.equal(zones.bottom.zone, "bottom");
    assert.equal(zones.left.zone, "left");
    assert.equal(zones.right.zone, "right");
    for (const name of ["tl", "top", "bottom", "left", "right", "br"]) assert.equal(zones[name].view, "ResizeOverlayView", name);
    assert.equal(zones["left-inner"].view, "NotesWebView");
    assert.equal(zones.strip.view, "DragStripView");
    assert.equal(zones.body.view, "NotesWebView");
  });

  // Real resize drags through the tracking loop. test.mouseDrag returns after the loop has
  // consumed the whole drag. A width only drag keeps auto-sizing on; a height drag turns it off.
  await call("settings.set", { windowAutoSize: true });
  const r0 = (await state()).frame;
  await call("test.mouseDrag", { x: r0.width - 3, y: r0.height / 2, dx: 40, dy: 0 });
  const r1 = (await state()).frame;
  const autoAfterWidth = (await call("settings.get")).windowAutoSize;
  await check("dragging the right edge widens the panel, left edge fixed, auto-sizing stays on", () => {
    assert.equal(r1.width, r0.width + 40, "width");
    assert.equal(r1.x, r0.x, "x");
    assert.equal(r1.height, r0.height, "height");
    assert.equal(autoAfterWidth, true, "windowAutoSize");
  });
  await call("test.mouseDrag", { x: 3, y: r1.height / 2, dx: -30, dy: 0 });
  const r2 = (await state()).frame;
  await check("dragging the left edge widens to the left, right edge fixed", () => {
    assert.equal(r2.width, r1.width + 30, "width");
    assert.equal(r2.x + r2.width, r1.x + r1.width, "right edge");
  });
  await call("test.mouseDrag", { x: r2.width / 2, y: r2.height - 3, dx: 0, dy: 60 });
  const r3 = (await state()).frame;
  settings = await call("settings.get");
  await check("dragging the bottom edge grows the height with the top fixed and turns auto-sizing off", () => {
    assert.equal(r3.height, r2.height + 60, "height");
    assert.equal(r3.top, r2.top, "top");
    assert.equal(settings.windowAutoSize, false, "windowAutoSize");
    assert.equal(settings.panelFrame.height, r3.height, "stored height");
  });
  await call("test.mouseDrag", { x: r3.width / 2, y: 3, dx: 0, dy: 40 });
  const r4 = (await state()).frame;
  await check("dragging the top edge moves the top, bottom edge fixed", () => {
    assert.equal(r4.height, r3.height - 40, "height");
    assert.equal(r4.y, r3.y, "bottom edge");
  });
  await call("test.mouseDrag", { x: r4.width - 3, y: r4.height - 3, dx: -3000, dy: -3000 });
  const r5 = (await state()).frame;
  await check("a corner drag stops at the minimum size (396 x 128 at 100%)", () => {
    assert.equal(r5.width, 396, "width");
    assert.equal(r5.height, 128, "height");
    assert.equal(r5.x, r4.x, "x");
    assert.equal(r5.top, r4.top, "top");
  });
  await call("test.simulateUserResize", { height: 300, width: 700 });

  // ⌘W hides the panel through the menu, the same path as the Close control.
  const eventsBeforeClose = (await call("test.events")).length;
  await call("test.keyDown", { key: "w", command: true });
  const closedState = await poll(state, (st) => !st.visible);
  markVisible(closedState.visible);
  const closeEvents = (await call("test.events")).slice(eventsBeforeClose).map((e) => e.event);
  await check("⌘W hides the panel and emits window.didHide", () => {
    assert.equal(closedState.visible, false, "visible");
    assert.ok(closeEvents.includes("window.didHide"), closeEvents.join(", "));
  });
  const reopen = await toggle();
  s = await poll(state, shownAndKey);
  await check("toggle reopens the panel after ⌘W", () => {
    assert.equal(reopen.visible, true, "window.toggle result");
    assert.equal(s.visible && s.key, true, "visible and key");
  });

  // Per display position memory. The panel opens on the display under the pointer, so these
  // checks also record which display that was; a pointer moved to another display mid run
  // shows up in the failure message instead of as a bare coordinate mismatch.
  const target = { x: Math.round(s.frame.x) - 40, top: Math.round(s.frame.top) - 30 };
  const shownOn = s.screenKey;
  await call("test.moveTo", target);
  const hideForMemory = await toggle();
  settings = await call("settings.get");
  await check("hide remembers the top left point for this display", () => {
    assert.equal(hideForMemory.visible, false, "window.toggle result");
    const point = settings.panelFrame.displays[shownOn];
    assert.deepEqual(point, { x: target.x, y: target.top });
  });
  const showForMemory = await toggle();
  s = await poll(state, shownAndKey);
  await check("show reopens at the remembered point", () => {
    assert.equal(showForMemory.visible, true, "window.toggle result");
    assert.equal(s.screenKey, shownOn, `the pointer moved to another display during the run (now ${s.pointerScreenKey})`);
    assert.equal(s.frame.x, target.x, "x");
    assert.equal(s.frame.top, target.top, "top");
  });
  const sizeBeforeRestart = s.frame;

  if (CAPTURE) {
    const shot = await poll(() => panelWindow(pid, s), (win) => win?.onscreen === true);
    execFileSync("screencapture", ["-x", "-o", "-l", String(shot.id), CAPTURE]);
    console.log(`[e2e] captured the panel window to ${CAPTURE}`);
  }
  await stop(helper);

  // Size and position survive a restart.
  helper = await start();
  await helper.call("window.show");
  visibleSince = Date.now();
  const after = await poll(() => helper.call("test.windowState"), (st) => st.visible);
  lastState = after;
  await check("size and per display position survive a restart", () => {
    assert.equal(after.visible, true, "visible");
    assert.equal(after.screenKey, shownOn, `the pointer moved to another display during the run (now ${after.pointerScreenKey})`);
    assert.equal(after.frame.x, target.x, "x");
    assert.equal(after.frame.top, target.top, "top");
    assert.equal(after.frame.width, sizeBeforeRestart.width, "width");
    assert.equal(after.frame.height, sizeBeforeRestart.height, "height");
  });
  await stop(helper);

  // The real editor build: served over overnote:// (strict CSP, lazy chunks), it must
  // reach system.ready and report its height. A fresh install opens at 640 x 560 (auto-sizing
  // off); with auto-sizing on, the panel follows the editor's height.
  args = argsFor(`${TMP}/support-editor`, EDITOR_DIR);
  helper = await start();
  const editorState = async () => (lastState = await helper.call("test.windowState"));
  let calls = await poll(() => helper.call("test.bridgeCalls"), (c) => c.methods.includes("system.ready"), PAGE_LOAD_MS);
  await check("real editor loads hidden and calls system.ready", () => {
    assert.ok(calls.methods.includes("system.ready"), `bridge calls: ${calls.methods.join(", ")}`);
  });
  await helper.call("window.show");
  visibleSince = Date.now();
  const firstEditor = await poll(editorState, (st) => st.visible);
  calls = await helper.call("test.bridgeCalls");
  await check("real editor, fresh install: the panel opens at 640 x 560 whatever the content reports", () => {
    assert.equal(firstEditor.visible, true, "visible");
    assert.equal(firstEditor.frame.width, 640, `width (bridge calls: ${calls.methods.join(", ")})`);
    assert.equal(firstEditor.frame.height, 560, `height (bridge calls: ${calls.methods.join(", ")}; reports ${calls.resizes.join(", ")})`);
  });
  if (CAPTURE) {
    const shot = await poll(() => panelWindow(helper.child.pid, firstEditor), (win) => win?.onscreen === true);
    const editorCapture = CAPTURE.replace(/(\.png)?$/, "-editor.png");
    execFileSync("screencapture", ["-x", "-o", "-l", String(shot.id), editorCapture]);
    console.log(`[e2e] captured the real editor panel to ${editorCapture}`);
  }
  calls = await helper.call("test.bridgeCalls");
  if (calls.methods.includes("window.setDragRegions")) {
    const withRegions = await poll(editorState, (st) => st.dragRects.length > 0);
    await check("real editor sends its drag regions", () => assert.ok(withRegions.dragRects.length > 0, "no drag rects"));
  } else {
    console.log("[e2e] note: this editor build does not call window.setDragRegions yet");
  }
  await helper.call("settings.set", { windowAutoSize: true });
  // The editor may still report new heights (fonts, lazy chunks); follow the latest report.
  let expected = 0;
  const followed = await poll(async () => {
    calls = await helper.call("test.bridgeCalls");
    const st = await editorState();
    const reported = calls.resizes.at(-1) ?? 0;
    expected = Math.min(Math.max(Math.ceil(reported), 128), Math.floor(Math.min(860, st.visibleFrameHeight)));
    return st;
  }, (st) => Math.abs(st.frame.height - expected) <= 2);
  await check("with auto-sizing on, the panel height follows the real editor's report", () => {
    assert.ok(calls.resizes.at(-1) > 0, "no window.resize");
    assert.ok(Math.abs(followed.frame.height - expected) <= 2, `height ${followed.frame.height}, expected ${expected}`);
  });
  await stop(helper);
  helper = null;
  const log = fs.readFileSync(`${TMP}/support-editor/helper.log`, "utf8");
  await check("every editor asset was served (no 404s)", () => assert.ok(!log.includes("asset not found"), log));

  console.log(`[e2e] warm show round trip ${showMs.toFixed(1)} ms; panel visible ${(visibleTotal / 1000).toFixed(1)} s in total`);
  console.log(`[e2e] ${passed} window checks passed`);
})().catch(async (error) => {
  // Name the failing check, point at the script line, and show the window as it was.
  const where = (error.stack || "").split("\n").find((line) => line.includes("[stdin]") || line.includes("[eval"));
  console.error(`[e2e] FAILED ${error.checkFailed ? "check" : "during"} "${currentStep}" after ${passed} passing checks`);
  console.error(`[e2e] ${error.message}`);
  if (where) console.error(`[e2e] ${where.trim()}`);
  if (lastState) {
    const { visible, key, frame, screenKey, pointerScreenKey } = lastState;
    console.error(`[e2e] last window state: ${JSON.stringify({ visible, key, frame, screenKey, pointerScreenKey })}`);
  }
  process.exit(1);
});
JS
