# Hotkey to caret ready: data collection design

This design is not implemented here.
It needs edits to `scripts/e2e-window.sh`, which this change does not own, and the window suite runs in CI only.
Do not run it on a workstation.

## The question

How long passes between the person pressing the hotkey and the moment they can type into the note with the caret placed?
Two cases matter.
Cold means no helper process is running and the editor has never loaded in this helper lifetime.
Warm means the helper is already running with the panel hidden and prewarmed, which is the state a second hotkey press finds.

## Timestamps to collect

Collect `t0` at the socket call that stands in for the hotkey, because the real Raycast hotkey path is outside the helper and outside this repository's control.
That choice measures helper plus editor, and it must be named that way in every report.
Collect `t1` when `window.toggle` or `window.show` returns.
Collect `t2` from `test.windowState` polling until the panel reports visible and key with the web view as first responder.
Collect `t3` from `test.bridgeCalls` when `system.ready` first appears, cold only.
Collect `t4` when the editor reports caret ready, defined below.
Report `t1 - t0`, `t2 - t0`, and `t4 - t0` as median and p95 over at least 20 warm runs and at least 5 cold runs, with cold runs each in a fresh helper process and a fresh support folder.

## Caret ready needs one editor hook

The window suite already evaluates page expressions through `test.js`.
Caret ready should be one expression with a stable meaning: the session is ready, the current note is loaded, the editor view has focus, and the selection sits at the stored caret position.
The editor does not expose that as one value today.
The clean hook is a read only `window.__overnotePerf` object, installed only when the helper passes a perf flag through the bridge or when the editor runs in the window suite.
It would expose `sessionReady`, `noteId`, `focused`, `selectionAnchor`, and `storedCaretPosition`.
Adding that object touches editor sources, so it belongs with the window suite change rather than this harness.
A weaker proxy exists today: poll `test.js` for `document.activeElement` inside the ProseMirror element plus a non-null selection through `window.getSelection()`.
Name any result from the proxy as caret proxy, never caret ready, because it cannot prove the caret matches the stored position.

## Warm protocol

Start the helper once in GUI mode with `--test-hooks`, the real editor build, and a fixture copied from this harness at the scale under test.
Wait for `system.ready` and for the placeholder free real editor to go quiet, using the same bridge call polling the window suite already uses.
Hide the panel with `window.hide` and wait until `test.windowState` reports hidden.
For each run, record `t0`, call `window.toggle`, poll for visible and key, then poll the caret expression, then call `window.hide`.
Discard the first run as warmup.
Never synthesize a real key event, and let the suite keep its rule that visible time stays short.

## Cold protocol

Use a fresh support folder and a fresh helper process per run.
Start the helper with `--show` and the real editor, as the extension launcher does.
Record `t0` just before spawn so process start, WebKit start, and editor load all count.
Poll `system.ping`, then `test.windowState`, then `test.bridgeCalls` for `system.ready`, then the caret expression.
Record each stage, because the split between process start, window show, and editor load is what tells the next fix where to land.
Stop the helper with `system.shutdown` between runs.

## Budgets and reporting

Add a `hotkeyCaret` section to `budgets.json` only after the first CI runs show a stable baseline.
Report warm and cold separately, and always name the fixture scale and the helper binary hash beside the numbers.
A single number without its scale would hide exactly the cost this collection exists to find.
