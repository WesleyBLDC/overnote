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
  const waitFor = async (fn, ms = 1500) => {
    for (let waited = 0; waited < ms; waited += 25) {
      if (await fn()) return true;
      await sleep(25);
    }
    return false;
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
    assert.equal(s.resizeZones, true);
    assert.equal(s.hidesOnDeactivate, false);
    assert.equal(s.acceptsFirstMouse, false);
    const server = panelWindow(pid, s);
    assert.ok(server, "window server does not list the panel");
    assert.equal(server.layer, 8, "window server layer should be the modal panel layer (8)");
    assert.equal(server.onscreen, true);
    assert.equal(server.sharing, 1, "shareable (read only) by default");
  });
  check("first open: 640 x 560, centered, top just under the menu bar, on the pointer's display", () => {
    const vf = s.visibleFrame;
    assert.equal(s.frame.width, 640);
    assert.equal(s.frame.height, 560);
    assert.ok(Math.abs(s.frame.x - (vf.x + vf.width / 2 - 320)) <= 1, `x ${s.frame.x}, visible ${JSON.stringify(vf)}`);
    assert.equal(s.frame.top, vf.y + vf.height);
    assert.equal(s.screenKey, s.pointerScreenKey);
  });
  const defaultsBefore = await call("settings.get");
  check("auto-sizing is off by default, so the placeholder's height report keeps 560", () => {
    assert.equal(defaultsBefore.windowAutoSize, false);
    assert.equal(defaultsBefore.panelFrame, null);
  });
  check("dark vibrancy material (HUD, active) under a transparent web view", () => {
    assert.equal(s.material, s.hudWindowMaterial);
    assert.equal(s.materialActive, true);
    assert.equal(s.webViewDrawsBackground, false);
  });
  // The height mechanics below run with auto-sizing on.
  await call("settings.set", { windowAutoSize: true });

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

  // While ⌘K, browse, or a dialog is open the editor sends a temporary taller report, then a
  // normal one. Reports are programmatic: they never turn auto-sizing off.
  await bridge("window.resize", { contentHeight: 442, temporary: true });
  const grown = (await state()).frame;
  const restored = await height(140);
  check("auto-sizing on: a temporary report grows to 442 and the next normal report restores", () => {
    assert.equal(grown.height, 442);
    assert.equal(grown.top, top);
    assert.equal(restored.height, 140);
  });
  assert.equal((await call("settings.get")).windowAutoSize, true);

  // Temporary growth only grows: a panel already taller than the request stays as it is.
  await height(600);
  await bridge("window.resize", { contentHeight: 442, temporary: true });
  const tallTemp = (await state()).frame;
  const tallAfter = await height(600);
  check("auto-sizing on: a temporary report on a taller panel changes nothing", () => {
    assert.equal(tallTemp.height, 600);
    assert.equal(tallTemp.top, top);
    assert.equal(tallAfter.height, 600);
  });
  await height(140);

  const menuItems = await call("test.menuItems");
  const menu = menuItems.filter((item) => item.menu === "Edit");
  const byKeys = Object.fromEntries(menu.map((item) => [item.keys, item.action]));
  const closeItem = menuItems.find((item) => item.keys === "⌘W");
  check("File menu: Close Window ⌘W targets the panel's hide path", () => {
    assert.ok(closeItem, JSON.stringify(menuItems));
    assert.equal(closeItem.title, "Close Window");
    assert.equal(closeItem.action, "closeWindow:");
    assert.equal(closeItem.hasTarget, true);
  });
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
    await waitFor(async () => (await state()).key);
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
  await call("test.simulateUserResize", { height: s.frame.height, width: 700 });
  let settings = await call("settings.get");
  check("width only resize keeps auto-sizing on", () => {
    assert.equal(settings.windowAutoSize, true);
    assert.equal(settings.panelFrame.width, 700);
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
  await bridge("window.resize", { contentHeight: 442, temporary: true });
  const tallEnough = (await state()).frame;
  const keptUserHeight = await height(200);
  check("auto-sizing off: a temporary report on a 500 pt panel is a no-op, and the next report keeps 500", () => {
    assert.equal(tallEnough.height, 500);
    assert.equal(keptUserHeight.height, 500);
    assert.equal((keptUserHeight.top), tallEnough.top);
  });

  // With auto-sizing off, a temporary report still grows the panel, and the next normal
  // report restores the user's stored height (not the content height).
  await call("test.simulateUserResize", { height: 300 });
  await bridge("window.resize", { contentHeight: 442, temporary: true });
  const grownOff = (await state()).frame;
  const storedDuringGrowth = (await call("settings.get")).panelFrame.height;
  const restoredOff = await height(200);
  check("auto-sizing off: a temporary report grows to 442 and the next normal report restores the user's height", () => {
    assert.equal(grownOff.height, 442);
    assert.equal(storedDuringGrowth, 300);
    assert.equal(restoredOff.height, 300);
  });
  assert.equal((await call("settings.get")).windowAutoSize, false);

  // Drag regions: a mouse down inside one drags the panel; anywhere else reaches the page.
  await assert.rejects(bridge("window.setDragRegions", { rects: "toolbar" }), /rects must be an array/);
  await assert.rejects(bridge("window.setDragRegions", { rects: [{ x: 0, y: 0, width: -1, height: 4 }] }), /negative/);
  await bridge("window.setDragRegions", { rects: [{ x: 100, y: 14, width: 200, height: 30 }] });
  s = await state();
  check("window.setDragRegions stores the rects", () =>
    assert.deepEqual(s.dragRects, [{ x: 100, y: 14, width: 200, height: 30 }]));
  await js("(window.__bnDowns = 0, document.addEventListener('mousedown', () => window.__bnDowns++, true), 0)");
  const downs = () => js("window.__bnDowns");
  let click = await call("test.mouseDown", { x: 150, y: 25 });
  await sleep(150);
  const downsAfterDrag = await downs();
  check("a mouse down in a drag region drags the window and never reaches the page", () => {
    assert.equal(click.drags, 1);
    assert.equal(downsAfterDrag, 0);
  });
  click = await call("test.mouseDown", { x: 50, y: 25 });
  const reachedPage = await waitFor(async () => (await downs()) === 1);
  check("a mouse down outside the drag regions reaches the page (toolbar buttons still click)", () => {
    assert.equal(click.drags, 0);
    assert.equal(reachedPage, true);
  });
  click = await call("test.mouseDown", { x: 350, y: 10 });
  check("the 12 pt top strip still drags as a fallback", () => assert.equal(click.drags, 1));
  await call("test.resignKey");
  await sleep(250);
  if (!(await state()).key) {
    click = await call("test.mouseDown", { x: 50, y: 25 });
    await sleep(200);
    const downsAfterFirst = await downs();
    check("first click into an unfocused panel only focuses it (no first mouse on the page)", () => {
      assert.equal(click.key, true);
      assert.equal(click.drags, 0);
      assert.equal(downsAfterFirst, 1);
    });
    await call("test.dropDecoy");
    await call("test.resignKey");
    await sleep(250);
    click = await call("test.mouseDown", { x: 150, y: 25 });
    check("a drag region drags even an unfocused panel, like a title bar", () => assert.equal(click.drags, 1));
    await call("test.dropDecoy");
  } else {
    await call("test.dropDecoy");
    console.log("[e2e] note: could not take key focus away; skipped the first mouse checks");
  }
  await bridge("window.setDragRegions", { rects: [] });
  const downsBeforeClear = await downs();
  click = await call("test.mouseDown", { x: 150, y: 25 });
  const reachedAfterClear = await waitFor(async () => (await downs()) === downsBeforeClear + 1);
  check("clearing the drag regions gives that area back to the page", () => {
    assert.equal(click.drags, 0);
    assert.equal(reachedAfterClear, true);
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
  check("resize hit zones: edges 8 pt, corners 16 pt, interior falls through to the web view and drag strip", () => {
    assert.equal(zones.tl.zone, "top-left");
    assert.equal(zones["tl-inner"].zone, "top-left");
    assert.equal(zones.tr.zone, "top-right");
    assert.equal(zones.bl.zone, "bottom-left");
    assert.equal(zones.br.zone, "bottom-right");
    assert.equal(zones.top.zone, "top");
    assert.equal(zones.bottom.zone, "bottom");
    assert.equal(zones.left.zone, "left");
    assert.equal(zones.right.zone, "right");
    for (const name of ["tl", "top", "bottom", "left", "right", "br"]) assert.equal(zones[name].view, "ResizeOverlayView");
    assert.equal(zones["left-inner"].view, "NotesWebView");
    assert.equal(zones.strip.view, "DragStripView");
    assert.equal(zones.body.view, "NotesWebView");
  });

  // Real resize drags through the tracking loop. A width only drag keeps auto-sizing on;
  // a height drag turns it off.
  await call("settings.set", { windowAutoSize: true });
  await sleep(50);
  let r0 = (await state()).frame;
  await call("test.mouseDrag", { x: r0.width - 3, y: r0.height / 2, dx: 40, dy: 0 });
  let r1 = (await state()).frame;
  let autoAfterWidth = (await call("settings.get")).windowAutoSize;
  check("dragging the right edge widens the panel, left edge fixed, auto-sizing stays on", () => {
    assert.equal(r1.width, r0.width + 40);
    assert.equal(r1.x, r0.x);
    assert.equal(r1.height, r0.height);
    assert.equal(autoAfterWidth, true);
  });
  await call("test.mouseDrag", { x: 3, y: r1.height / 2, dx: -30, dy: 0 });
  let r2 = (await state()).frame;
  check("dragging the left edge widens to the left, right edge fixed", () => {
    assert.equal(r2.width, r1.width + 30);
    assert.equal(r2.x + r2.width, r1.x + r1.width);
  });
  await call("test.mouseDrag", { x: r2.width / 2, y: r2.height - 3, dx: 0, dy: 60 });
  let r3 = (await state()).frame;
  settings = await call("settings.get");
  check("dragging the bottom edge grows the height with the top fixed and turns auto-sizing off", () => {
    assert.equal(r3.height, r2.height + 60);
    assert.equal(r3.top, r2.top);
    assert.equal(settings.windowAutoSize, false);
    assert.equal(settings.panelFrame.height, r3.height);
  });
  await call("test.mouseDrag", { x: r3.width / 2, y: 3, dx: 0, dy: 40 });
  let r4 = (await state()).frame;
  check("dragging the top edge moves the top, bottom edge fixed", () => {
    assert.equal(r4.height, r3.height - 40);
    assert.equal(r4.y, r3.y);
  });
  await call("test.mouseDrag", { x: r4.width - 3, y: r4.height - 3, dx: -3000, dy: -3000 });
  let r5 = (await state()).frame;
  check("a corner drag stops at the minimum size (396 x 128 at 100%)", () => {
    assert.equal(r5.width, 396);
    assert.equal(r5.height, 128);
    assert.equal(r5.x, r4.x);
    assert.equal(r5.top, r4.top);
  });
  await call("test.simulateUserResize", { height: 300, width: 700 });

  // ⌘W hides the panel through the menu, the same path as the Close control.
  const eventsBeforeClose = (await call("test.events")).length;
  await call("test.keyDown", { key: "w", command: true });
  const closed = await waitFor(async () => !(await state()).visible);
  markVisible(false);
  const closeEvents = (await call("test.events")).slice(eventsBeforeClose).map((e) => e.event);
  check("⌘W hides the panel and emits window.didHide", () => {
    assert.equal(closed, true);
    assert.ok(closeEvents.includes("window.didHide"), closeEvents.join(", "));
  });
  assert.equal((await toggle()).visible, true);
  await sleep(100);

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
  const sizeBeforeRestart = s.frame;

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
    assert.equal(after.frame.width, sizeBeforeRestart.width);
    assert.equal(after.frame.height, sizeBeforeRestart.height);
  });
  await stop(helper);

  // The real editor build: served over overnote:// (strict CSP, lazy chunks), it must
  // reach system.ready and report its height. A fresh install opens at 640 x 560 (auto-sizing
  // off); with auto-sizing on, the panel follows the editor's height.
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
  await helper.call("window.show");
  visibleSince = Date.now();
  for (let i = 0; i < 60; i++) {
    calls = await helper.call("test.bridgeCalls");
    if (calls.resizes.length > 0) break;
    await sleep(25);
  }
  await sleep(150);
  const firstEditor = await helper.call("test.windowState");
  check("real editor, fresh install: the panel opens at 640 x 560 whatever the content reports", () => {
    assert.equal(firstEditor.frame.width, 640);
    assert.equal(firstEditor.frame.height, 560);
  });
  if (CAPTURE) {
    const server = panelWindow(helper.child.pid, firstEditor);
    const editorCapture = CAPTURE.replace(/(\.png)?$/, "-editor.png");
    execFileSync("screencapture", ["-x", "-o", "-l", String(server.id), editorCapture]);
    console.log(`[e2e] captured the real editor panel to ${editorCapture}`);
  }
  calls = await helper.call("test.bridgeCalls");
  if (calls.methods.includes("window.setDragRegions")) {
    check("real editor sends its drag regions", () => assert.ok(firstEditor.dragRects.length > 0));
  } else {
    console.log("[e2e] note: this editor build does not call window.setDragRegions yet");
  }
  await helper.call("settings.set", { windowAutoSize: true });
  await sleep(300);
  calls = await helper.call("test.bridgeCalls");
  const shownEditor = await helper.call("test.windowState");
  const reported = calls.resizes.at(-1);
  check("real editor reports window.resize", () => assert.ok(reported > 0, "no window.resize"));
  const expected = Math.min(Math.max(Math.ceil(reported), 128), Math.floor(Math.min(860, shownEditor.visibleFrameHeight)));
  check("with auto-sizing on, the panel height follows the real editor's report", () => {
    assert.ok(Math.abs(shownEditor.frame.height - expected) <= 2, `height ${shownEditor.frame.height}, expected ${expected}`);
  });
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
