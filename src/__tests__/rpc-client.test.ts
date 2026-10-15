import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RpcClient, RpcConnectionError, RpcError, RpcTimeoutError, defaultTimeoutFor } from "../domain/rpc-client";
import { shortTempDir } from "./helpers";

type Handler = (request: { id: number; method: string; params: unknown }, socket: net.Socket) => void;

interface FakeServer {
  socketPath: string;
  connections: number;
  requests: { method: string; params: unknown }[];
  sockets: net.Socket[];
  close: () => Promise<void>;
}

function reply(socket: net.Socket, payload: object) {
  socket.write(`${JSON.stringify(payload)}\n`);
}

async function startServer(dir: string, handler: Handler): Promise<FakeServer> {
  const socketPath = path.join(dir, "helper.sock");
  const state: FakeServer = {
    socketPath,
    connections: 0,
    requests: [],
    sockets: [],
    close: async () => undefined,
  };
  const server = net.createServer((socket) => {
    state.connections += 1;
    state.sockets.push(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        state.requests.push({ method: request.method, params: request.params });
        handler(request, socket);
        newline = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  state.close = () =>
    new Promise<void>((resolve) => {
      for (const socket of state.sockets) socket.destroy();
      server.close(() => resolve());
    });
  return state;
}

describe("RpcClient", () => {
  let dir: string;
  let server: FakeServer | undefined;
  let client: RpcClient | undefined;

  beforeEach(() => {
    dir = shortTempDir();
  });

  afterEach(async () => {
    client?.close();
    await server?.close();
    server = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends newline-delimited requests and resolves results", async () => {
    server = await startServer(dir, (request, socket) =>
      reply(socket, { id: request.id, result: { version: "1.2.3", pid: 42 } }),
    );
    client = new RpcClient({ socketPath: server.socketPath });
    await expect(client.call("system.ping", {})).resolves.toEqual({ version: "1.2.3", pid: 42 });
    expect(server.requests).toEqual([{ method: "system.ping", params: {} }]);
  });

  it("matches out of order responses by id and reuses one connection", async () => {
    const held: { id: number; socket: net.Socket }[] = [];
    server = await startServer(dir, (request, socket) => {
      held.push({ id: request.id, socket });
      if (held.length === 3) {
        for (const entry of [...held].reverse()) {
          reply(entry.socket, { id: entry.id, result: { visible: entry.id % 2 === 0 } });
        }
      }
    });
    client = new RpcClient({ socketPath: server.socketPath });
    const results = await Promise.all([
      client.call("window.toggle", {}),
      client.call("window.toggle", {}),
      client.call("window.toggle", {}),
    ]);
    expect(results).toEqual([{ visible: false }, { visible: true }, { visible: false }]);
    await client.call("window.toggle", {}).catch(() => undefined);
    expect(server.connections).toBe(1);
  });

  it("handles a response split across chunks and several responses in one chunk", async () => {
    server = await startServer(dir, (request, socket) => {
      const text = `${JSON.stringify({ id: request.id, result: { count: request.id } })}\n`;
      socket.write(text.slice(0, 5));
      setTimeout(() => socket.write(text.slice(5)), 10);
    });
    client = new RpcClient({ socketPath: server.socketPath });
    await expect(client.call("notes.count", {})).resolves.toEqual({ count: 1 });
  });

  it("turns error responses into RpcError with the code", async () => {
    server = await startServer(dir, (request, socket) =>
      reply(socket, { id: request.id, error: { code: 404, message: "Note not found" } }),
    );
    client = new RpcClient({ socketPath: server.socketPath });
    const error = await client.call("notes.get", { id: "missing" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: 404, message: "Note not found", method: "notes.get" });
  });

  it("times out a call without breaking the connection", async () => {
    server = await startServer(dir, (request, socket) => {
      if (request.method === "notes.count") reply(socket, { id: request.id, result: { count: 7 } });
    });
    client = new RpcClient({ socketPath: server.socketPath });
    await expect(client.call("window.toggle", {}, { timeoutMs: 50 })).rejects.toBeInstanceOf(RpcTimeoutError);
    await expect(client.call("notes.count", {})).resolves.toEqual({ count: 7 });
    expect(server.connections).toBe(1);
  });

  it("uses the contract timeouts", () => {
    expect(defaultTimeoutFor("notes.list")).toBe(3000);
    expect(defaultTimeoutFor("system.shutdown")).toBe(10000);
  });

  it("rejects in-flight calls when the server goes away, then reconnects", async () => {
    server = await startServer(dir, (request, socket) => {
      if (request.method === "window.toggle") socket.destroy();
      else reply(socket, { id: request.id, result: { count: 1 } });
    });
    client = new RpcClient({ socketPath: server.socketPath });
    await expect(client.call("window.toggle", {})).rejects.toBeInstanceOf(RpcConnectionError);
    await expect(client.call("notes.count", {})).resolves.toEqual({ count: 1 });
    expect(server.connections).toBe(2);
  });

  it("fails fast with RpcConnectionError when nothing listens", async () => {
    client = new RpcClient({ socketPath: path.join(dir, "missing.sock") });
    await expect(client.call("system.ping", {})).rejects.toBeInstanceOf(RpcConnectionError);
  });

  it("ignores junk lines and unknown ids", async () => {
    server = await startServer(dir, (request, socket) => {
      socket.write("not json\n");
      reply(socket, { id: 9999, result: {} });
      reply(socket, { id: request.id, result: { count: 3 } });
    });
    client = new RpcClient({ socketPath: server.socketPath });
    await expect(client.call("notes.count", {})).resolves.toEqual({ count: 3 });
  });
});
