/**
 * Installs a fake window.webkit.messageHandlers.betterNotes backed by MockStore,
 * so the editor runs in a normal browser. Tests drive it through window.__betterNotesMock.
 */
import { buildNoteContent, markdownToDoc, rpc, type Note } from "@better-notes/core";
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
  webkit?: { messageHandlers?: { betterNotes?: { postMessage(message: OutgoingMessage): void } } };
  betterNotesBridge?: BridgeReceiver;
  __betterNotesMock?: MockControl;
}

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
  control.seedMarkdown(["# Welcome to Better Notes\n\nA floating notepad, one hotkey away.\n\n- [ ] Try ⌘↩ on this task\n- [x] Open the dev harness"]);
}

export function installMockBridge(target: MockWindow & Window): MockControl {
  const receiver = (): BridgeReceiver | undefined => target.betterNotesBridge;
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
      betterNotes: {
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
  target.__betterNotesMock = control;
  target.document.documentElement.dataset.harness = "true";
  seedFromUrl(control, target.location.search);
  return control;
}
