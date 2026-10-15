/**
 * The web side of the WKWebView bridge (docs/contract.md section 3).
 * Requests go out through window.webkit.messageHandlers.betterNotes; the native side answers by
 * calling window.betterNotesBridge.resolve / reject and pushes events through emit.
 */
import { rpc, type RpcErrorPayload } from "@better-notes/core";

type MethodName = rpc.MethodName;
type EventName = rpc.EventName;

export interface OutgoingMessage {
  id: number;
  method: string;
  params: unknown;
}

/** What the native side installs on window.webkit. */
export interface MessagePort {
  postMessage(message: OutgoingMessage): void;
}

/** What the editor installs on window.betterNotesBridge for the native side to call. */
export interface BridgeReceiver {
  resolve(id: number | string, result: unknown): void;
  reject(id: number | string, error: RpcErrorPayload): void;
  emit(event: string, payload: unknown): void;
}

export class BridgeError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly method: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export const TIMEOUT_CODE = -1;

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Listener<E extends EventName> = (payload: rpc.Events[E]) => void;
type AnyListener = (payload: unknown) => void;

export interface BridgeOptions {
  timeoutMs?: number;
  /** Events that arrive before anyone listens are kept, up to this many per event. */
  bufferLimit?: number;
}

export class BridgeClient implements BridgeReceiver {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<AnyListener>>();
  private readonly buffered = new Map<string, unknown[]>();
  private readonly timeoutMs: number;
  private readonly bufferLimit: number;

  constructor(
    private readonly port: () => MessagePort | undefined,
    options: BridgeOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? rpc.TIMEOUT_MS;
    this.bufferLimit = options.bufferLimit ?? 20;
  }

  call<M extends MethodName>(method: M, params: rpc.Params<M>): Promise<rpc.Result<M>> {
    const id = this.nextId++;
    return new Promise<rpc.Result<M>>((resolve, reject) => {
      const port = this.port();
      if (!port) {
        reject(new BridgeError(rpc.ErrorCode.Internal, "Native bridge is not available", method));
        return;
      }
      const timeout = method === rpc.Method.SystemShutdown ? rpc.SHUTDOWN_TIMEOUT_MS : this.timeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(TIMEOUT_CODE, `${method} timed out after ${timeout} ms`, method));
      }, timeout);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as rpc.Result<M>),
        reject,
        timer,
      });
      try {
        port.postMessage({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError(rpc.ErrorCode.Internal, String(error), method));
      }
    });
  }

  resolve(id: number | string, result: unknown): void {
    const entry = this.take(id);
    entry?.resolve(result);
  }

  reject(id: number | string, error: RpcErrorPayload): void {
    const entry = this.take(id);
    entry?.reject(new BridgeError(error?.code ?? rpc.ErrorCode.Internal, error?.message ?? "Unknown error", entry.method));
  }

  emit(event: string, payload: unknown): void {
    const set = this.listeners.get(event);
    if (set && set.size > 0) {
      for (const listener of [...set]) {
        try {
          listener(payload);
        } catch (error) {
          console.error(`[bridge] listener for ${event} failed`, error);
        }
      }
      return;
    }
    const queue = this.buffered.get(event) ?? [];
    queue.push(payload);
    if (queue.length > this.bufferLimit) queue.shift();
    this.buffered.set(event, queue);
  }

  on<E extends EventName>(event: E, listener: Listener<E>): () => void {
    const set = this.listeners.get(event) ?? new Set<AnyListener>();
    const wrapped = listener as AnyListener;
    set.add(wrapped);
    this.listeners.set(event, set);
    const queued = this.buffered.get(event);
    if (queued) {
      this.buffered.delete(event);
      for (const payload of queued) wrapped(payload);
    }
    return () => {
      set.delete(wrapped);
    };
  }

  /** Number of requests still waiting for an answer. */
  get inFlight(): number {
    return this.pending.size;
  }

  private take(id: number | string): Pending | undefined {
    const key = Number(id);
    const entry = this.pending.get(key);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    this.pending.delete(key);
    return entry;
  }
}

export interface BridgeWindow {
  webkit?: { messageHandlers?: { betterNotes?: MessagePort } };
  betterNotesBridge?: BridgeReceiver;
}

/** Creates the client and publishes it as window.betterNotesBridge before anything is sent. */
export function installBridge(target: BridgeWindow, options?: BridgeOptions): BridgeClient {
  const client = new BridgeClient(() => target.webkit?.messageHandlers?.betterNotes, options);
  target.betterNotesBridge = {
    resolve: (id, result) => client.resolve(id, result),
    reject: (id, error) => client.reject(id, error),
    emit: (event, payload) => client.emit(event, payload),
  };
  return client;
}

export function hasNativeBridge(target: BridgeWindow): boolean {
  return Boolean(target.webkit?.messageHandlers?.betterNotes);
}
