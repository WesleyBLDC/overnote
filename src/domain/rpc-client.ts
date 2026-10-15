import net from "node:net";

import type { RpcMethod, RpcParams, RpcResult } from "./types";

export const DEFAULT_TIMEOUT_MS = 3000;
export const SHUTDOWN_TIMEOUT_MS = 10000;
const DEFAULT_CONNECT_TIMEOUT_MS = 1000;

/** The helper answered with an error object. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly method: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** The helper did not answer in time. */
export class RpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`Overnote helper did not answer ${method} within ${timeoutMs} ms`);
    this.name = "RpcTimeoutError";
  }
}

/** The socket could not be reached, or it closed while a call was in flight. */
export class RpcConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "RpcConnectionError";
  }
}

export interface CallOptions {
  timeoutMs?: number;
}

export interface RpcClientOptions {
  socketPath: string;
  connectTimeoutMs?: number;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ResponseLine {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/** Backups and restores copy the whole database, so they get longer than ordinary calls. */
export const BACKUP_TIMEOUT_MS = 60000;

export function defaultTimeoutFor(method: string): number {
  if (method === "system.backup" || method === "system.restoreBackup") return BACKUP_TIMEOUT_MS;
  return method === "system.shutdown" ? SHUTDOWN_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/**
 * Newline-delimited JSON-RPC over a Unix domain socket (docs/architecture.md section 2).
 *
 * One connection is reused for every call and many calls can be in flight at once; replies are
 * matched by id. The socket is unref'd while idle so an open connection never keeps a command alive.
 */
export class RpcClient {
  private readonly socketPath: string;
  private readonly connectTimeoutMs: number;
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private nextId = 1;

  constructor(options: RpcClientOptions) {
    this.socketPath = options.socketPath;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  get isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  async call<M extends RpcMethod>(method: M, params: RpcParams<M>, options: CallOptions = {}): Promise<RpcResult<M>> {
    const socket = await this.connect();
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? defaultTimeoutFor(method);

    return new Promise<RpcResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.updateRef();
        reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as RpcResult<M>),
        reject,
        timer,
      });
      this.updateRef();
      socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (error) this.settle(id, { error: new RpcConnectionError(`Could not send ${method}`, error) });
      });
    });
  }

  /** Closes the connection and rejects anything still in flight. */
  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    socket?.destroy();
    this.failAll(new RpcConnectionError("Connection closed"));
  }

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;

    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new RpcConnectionError(`Timed out connecting to ${this.socketPath}`));
      }, this.connectTimeoutMs);

      socket.setEncoding("utf8");
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        this.connecting = null;
        socket.on("error", () => undefined);
        socket.on("close", () => this.onClose(socket));
        socket.on("data", (chunk: string) => this.onData(chunk));
        this.updateRef();
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        this.connecting = null;
        reject(new RpcConnectionError(`Could not connect to ${this.socketPath}`, error));
      });
    });
    return this.connecting;
  }

  private onClose(socket: net.Socket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.buffer = "";
    this.failAll(new RpcConnectionError("Overnote helper closed the connection"));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: ResponseLine;
    try {
      message = JSON.parse(line) as ResponseLine;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    if (message.error) {
      const code = typeof message.error.code === "number" ? message.error.code : 500;
      const text = typeof message.error.message === "string" ? message.error.message : "Unknown helper error";
      this.settle(message.id, { error: new RpcError(code, text, entry.method) });
    } else {
      this.settle(message.id, { value: message.result ?? null });
    }
  }

  private settle(id: number, outcome: { value: unknown } | { error: Error }): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    this.updateRef();
    if ("error" in outcome) entry.reject(outcome.error);
    else entry.resolve(outcome.value);
  }

  private failAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { error });
  }

  private updateRef(): void {
    if (!this.socket) return;
    if (this.pending.size > 0) this.socket.ref();
    else this.socket.unref();
  }
}

const sharedClients = new Map<string, RpcClient>();

/** One client per socket path for the lifetime of the command process. */
export function sharedClient(socketPath: string): RpcClient {
  let client = sharedClients.get(socketPath);
  if (!client) {
    client = new RpcClient({ socketPath });
    sharedClients.set(socketPath, client);
  }
  return client;
}

export function closeSharedClients(): void {
  for (const client of sharedClients.values()) client.close();
  sharedClients.clear();
}
