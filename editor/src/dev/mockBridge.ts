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
}

interface MockWindow {
  webkit?: { messageHandlers?: { overnote?: { postMessage(message: OutgoingMessage): void } } };
  overnoteBridge?: BridgeReceiver;
  __overnoteMock?: MockControl;
}

/** The helper's first-open panel height in points when auto-sizing is off (docs/architecture.md section 4). */
const FIRST_OPEN_HEIGHT = 560;

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

export function installMockBridge(target: MockWindow & Window): MockControl {
  // Emulates the helper's panel sizing: clamp to 128 to 860 points times zoom. With auto-sizing off
  // the panel opens at the roomy first-open size. Temporary heights only ever grow the panel (a tall
  // enough panel stays as it is) and the next normal report restores the resting height.
  let restingHeight: number | null = null;
  const applyPanelHeight = ({ contentHeight, temporary }: { contentHeight: number; temporary?: boolean }) => {
    const root = target.document.getElementById("root");
    if (!root) return;
    const zoom = control.store.settings.zoom;
    const clamp = (value: number) => Math.min(860 * zoom, Math.max(128 * zoom, value));
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
              // The harness panel cannot grow a transparent strip like the helper's window does,
              // so it lets the dropdown draw past its bottom edge instead.
              if (message.method === "window.setOverhang") {
                const root = target.document.getElementById("root");
                if (root) root.style.overflow = (params as { height: number }).height > 0 ? "visible" : "";
              }
              receiver()?.resolve(message.id, control.store.dispatch(message.method, params));
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
  if (!control.store.settings.windowAutoSize) {
    restingHeight = FIRST_OPEN_HEIGHT;
    const root = target.document.getElementById("root");
    if (root) root.style.height = `${FIRST_OPEN_HEIGHT}px`;
  }
  return control;
}
