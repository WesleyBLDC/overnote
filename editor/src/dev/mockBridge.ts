/**
 * Installs a fake window.webkit.messageHandlers.overnote backed by MockStore,
 * so the editor runs in a normal browser. Tests drive it through window.__overnoteMock.
 */
import { buildNoteContent, markdownToDoc, rpc, type Note } from "@overnote/core";
import type { BridgeReceiver, OutgoingMessage } from "../bridge/client";
import { MockRpcError, MockStore } from "./mockStore";

export interface RecordedCall {
  method: string;
  params: unknown;
  at: number;
}

export interface MockControl {
  store: MockStore;
  calls: RecordedCall[];
  /** Milliseconds before each reply. */
  latency: number;
  /** Methods that fail on their next call, with the given error code. */
  failNext: Record<string, number>;
  /** Methods that never answer (to exercise timeouts). */
  hang: Set<string>;
  emit(event: rpc.EventName, payload: unknown): void;
  callsTo(method: string): RecordedCall[];
  clearCalls(): void;
  seedMarkdown(markdowns: string[]): Note[];
  /** Resizes the harness panel, as a person dragging the native panel's edges would. */
  setPanelSize(width: number, height: number): void;
}

interface MockWindow {
  webkit?: { messageHandlers?: { overnote?: { postMessage(message: OutgoingMessage): void } } };
  overnoteBridge?: BridgeReceiver;
  __overnoteMock?: MockControl;
}

/** The helper's first-open panel height in points when auto-sizing is off (docs/architecture.md section 4). */
const FIRST_OPEN_HEIGHT = 560;
/** The smallest panel at any zoom (PanelSizing.floorSize in the helper). */
const FLOOR = { width: 405, height: 197 };

function seedFromUrl(control: MockControl, search: string): void {
  const params = new URLSearchParams(search);
  const seed = params.get("seed");
  if (seed === "empty") return;
  if (seed) {
    try {
      control.seedMarkdown(JSON.parse(seed) as string[]);
      return;
    } catch {
      // fall through to the default seed
    }
  }
  control.seedMarkdown([
    "# Welcome to Overnote\n\nA floating notepad, one hotkey away.\n\n- [ ] Try ⌘↩ on this task\n- [x] Open the dev harness",
  ]);
}

/**
 * Slow, hung, and failing methods from the URL, so a state that needs a misbehaving helper can be
 * opened by hand: `?mockLatency=600`, `?mockHang=notes.browse`, `?mockFail=notes.browse,notes.listDeleted`
 * (each listed method fails once). Method lists are comma separated.
 */
function faultsFromUrl(control: MockControl, search: string): void {
  const params = new URLSearchParams(search);
  const methods = (name: string) => (params.get(name) ?? "").split(",").filter(Boolean);
  const latency = Number(params.get("mockLatency"));
  if (Number.isFinite(latency) && latency > 0) control.latency = latency;
  for (const method of methods("mockHang")) control.hang.add(method);
  for (const method of methods("mockFail")) control.failNext[method] = rpc.ErrorCode.Internal;
}

export function installMockBridge(target: MockWindow & Window): MockControl {
  // Emulates the helper's panel sizing: heights from the minimum size (the editor's report, at least
  // 405 x 197) to 860 points times zoom. With auto-sizing off the panel opens at the roomy first-open
  // size. Temporary heights only ever grow the panel (a tall enough panel stays as it is) and the next
  // normal report restores the resting height. A new minimum grows a smaller panel.
  let restingHeight: number | null = null;
  let minimum = { ...FLOOR };
  const applyPanelHeight = ({ contentHeight, temporary }: { contentHeight: number; temporary?: boolean }) => {
    const root = target.document.getElementById("root");
    if (!root) return;
    const zoom = control.store.settings.zoom;
    const clamp = (value: number) => Math.min(Math.max(860 * zoom, minimum.height), Math.max(minimum.height, value));
    if (temporary) {
      const current = root.getBoundingClientRect().height;
      if (current < contentHeight) root.style.height = `${clamp(contentHeight)}px`;
      return;
    }
    if (control.store.settings.windowAutoSize || restingHeight === null) restingHeight = clamp(contentHeight);
    root.style.height = `${restingHeight}px`;
  };
  const receiver = (): BridgeReceiver | undefined => target.overnoteBridge;
  const control: MockControl = {
    store: new MockStore({
      emit: (event, payload) => setTimeout(() => receiver()?.emit(event, payload), 0),
    }),
    calls: [],
    latency: 5,
    failNext: {},
    hang: new Set(),
    emit: (event, payload) => receiver()?.emit(event, payload),
    callsTo: (method) => control.calls.filter((call) => call.method === method),
    clearCalls: () => {
      control.calls.length = 0;
    },
    seedMarkdown: (markdowns) => control.store.seed(markdowns.map((md) => buildNoteContent(markdownToDoc(md)))),
    setPanelSize: (width, height) => {
      const root = target.document.getElementById("root");
      if (!root) return;
      restingHeight = Math.max(height, minimum.height);
      root.style.maxWidth = "none";
      root.style.width = `${Math.max(width, minimum.width)}px`;
      root.style.height = `${restingHeight}px`;
    },
  };

  target.webkit = {
    messageHandlers: {
      overnote: {
        postMessage(message: OutgoingMessage) {
          const params = JSON.parse(JSON.stringify(message.params ?? {})) as unknown;
          control.calls.push({ method: message.method, params, at: Date.now() });
          if (control.hang.has(message.method)) return;
          setTimeout(() => {
            const code = control.failNext[message.method];
            if (code !== undefined) {
              delete control.failNext[message.method];
              receiver()?.reject(message.id, { code, message: `Injected failure for ${message.method}` });
              return;
            }
            try {
              if (message.method === "window.resize")
                applyPanelHeight(params as { contentHeight: number; temporary?: boolean });
              const panelRoot = target.document.getElementById("root");
              if (message.method === "window.place" && panelRoot) {
                // The page stands in for the display and the root element for the panel.
                const box = panelRoot.getBoundingClientRect();
                control.store.harness = {
                  visible: { width: target.innerWidth, height: target.innerHeight },
                  current: { width: box.width, height: box.height },
                  minimum: { ...minimum },
                };
              }
              if (message.method === "window.setMinimumSize") {
                const size = params as { width: number; height: number };
                minimum = {
                  width: Math.max(FLOOR.width, Math.ceil(size.width)),
                  height: Math.max(FLOOR.height, Math.ceil(size.height)),
                };
                const root = target.document.getElementById("root");
                const box = root?.getBoundingClientRect();
                if (root && box && box.height < minimum.height) {
                  restingHeight = Math.max(restingHeight ?? 0, minimum.height);
                  root.style.height = `${minimum.height}px`;
                }
                if (root && box && box.width < minimum.width) {
                  root.style.maxWidth = "none";
                  root.style.width = `${minimum.width}px`;
                }
              }
              const result = control.store.dispatch(message.method, params);
              if (message.method === "window.place") {
                const { frame } = result as rpc.Result<"window.place">;
                control.setPanelSize(frame.width, frame.height);
                // AppKit stores y as the top edge from the bottom. The harness page is the display.
                const root = target.document.getElementById("root");
                if (root) {
                  root.style.position = "absolute";
                  root.style.margin = "0";
                  root.style.left = `${frame.x}px`;
                  root.style.top = `${target.innerHeight - frame.y}px`;
                }
              }
              receiver()?.resolve(message.id, result);
            } catch (error) {
              const code = error instanceof MockRpcError ? error.code : rpc.ErrorCode.Internal;
              receiver()?.reject(message.id, { code, message: String((error as Error).message) });
            }
          }, control.latency);
        },
      },
    },
  };
  target.__overnoteMock = control;
  target.document.documentElement.dataset.harness = "true";
  seedFromUrl(control, target.location.search);
  faultsFromUrl(control, target.location.search);
  if (!control.store.settings.windowAutoSize) {
    restingHeight = FIRST_OPEN_HEIGHT;
    const root = target.document.getElementById("root");
    if (root) root.style.height = `${FIRST_OPEN_HEIGHT}px`;
  }
  return control;
}
