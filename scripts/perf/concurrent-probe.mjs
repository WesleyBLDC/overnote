#!/usr/bin/env node
// Concurrent probe: saves issued while a paging walk and folded LIKE scans are in flight.
//
// The point is not single client medians, which driver.mjs reports, but whether a write
// waits behind a long read. Before the read only second connection, one lock serialized
// reads and writes, so a save queued behind every in flight page and scan. This probe
// keeps a reader connection busy on a second socket connection and times saves on the
// writer connection, then reports both, as JSON on stdout.
//
// Usage:
//   node scripts/perf/concurrent-probe.mjs --fixture <dir> --helper <path> [--label before]
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const fixtureDir = arg("fixture", null);
const helper = arg("helper", "assets/bin/OvernoteHelper");
const label = arg("label", "probe");
if (!fixtureDir) {
  console.error("probe: --fixture is required");
  process.exit(64);
}
const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overnote-probe-"));
const support = path.join(tmp, "support");
fs.mkdirSync(support, { recursive: true });
fs.mkdirSync(path.join(tmp, "run"), { recursive: true });
fs.copyFileSync(path.join(fixtureDir, "support", "notes.sqlite"), path.join(support, "notes.sqlite"));
const socketPath = path.join(tmp, "run", "helper.sock");

const round = (v) => Math.round(v * 1000) / 1000;
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, medianMs: round(pick(0.5)), p95Ms: round(pick(0.95)), maxMs: round(s.at(-1)) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect() {
  const socket = net.createConnection(socketPath);
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const call = (method, params = {}, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  return {
    socket,
    call,
    connected: new Promise((res, rej) => {
      socket.once("connect", res);
      socket.once("error", rej);
    }),
  };
}

async function timed(fn) {
  const t0 = process.hrtime.bigint();
  const result = await fn();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, result };
}

let child;
try {
  child = spawn(
    helper,
    [
      "--support-dir",
      support,
      "--socket",
      socketPath,
      "--pid-file",
      path.join(tmp, "run", "helper.pid"),
      "--editor-dir",
      path.join(tmp, "no-editor"),
      "--headless",
      "--test-hooks",
    ],
    { env: { ...process.env, OVERNOTE_BACKUP_DIR: path.join(tmp, "backups") }, stdio: "ignore" },
  );
  let writer = null;
  for (let i = 0; i < 200 && !writer; i++) {
    if (fs.existsSync(socketPath)) {
      const probe = connect();
      try {
        await probe.connected;
        await probe.call("system.ping");
        writer = probe;
      } catch {
        probe.socket.destroy();
      }
    }
    if (!writer) await sleep(25);
  }
  if (!writer) throw new Error("helper never answered system.ping");
  const reader = connect();
  await reader.connected;

  const seedText = "Probe save target\nseed";
  const target = await writer.call("notes.create", {
    rawContent: JSON.stringify({ type: "doc" }),
    markdown: seedText,
    text: seedText,
    title: "Probe save target",
  });
  let expected = target.updatedAt;
  async function save(i) {
    const text = `Probe save ${i}\nbody ${i}`;
    const one = await timed(() =>
      writer.call("notes.update", {
        id: target.id,
        expectedUpdatedAt: expected,
        rawContent: JSON.stringify({ type: "doc" }),
        markdown: text,
        text,
        title: `Probe save ${i}`,
      }),
    );
    if (one.result.status !== "ok") throw new Error("save conflicted");
    expected = one.result.note.updatedAt;
    return one.ms;
  }

  const baseline = [];
  for (let i = 0; i < 15; i++) baseline.push(await save(i));

  // Keep the reader busy: short folded terms fall back to the LIKE scan over every folded
  // row, and paging walks run between scans, exactly the mix a save used to queue behind.
  let stop = false;
  let readsDone = 0;
  const readLatencies = [];
  const readerLoop = (async () => {
    while (!stop) {
      readLatencies.push((await timed(() => reader.call("notes.browse", { filter: "zx", limit: 100 }))).ms);
      readsDone++;
      let cursor;
      for (let page = 0; page < 10 && !stop; page++) {
        const one = await timed(() => reader.call("notes.list", { limit: 100, ...(cursor ? { cursor } : {}) }));
        readLatencies.push(one.ms);
        readsDone++;
        cursor = one.result.nextCursor;
        if (!cursor) break;
      }
    }
  })();
  await sleep(150);
  const concurrent = [];
  // Spaced 10 ms apart, so the saves span several of the reader's long scans.
  for (let i = 0; i < 20; i++) {
    concurrent.push(await save(100 + i));
    await sleep(10);
  }
  stop = true;
  await readerLoop;

  console.log(
    JSON.stringify(
      {
        kind: "concurrent",
        label,
        noteCount: manifest.noteCount,
        baselineSave: stats(baseline),
        concurrentSave: stats(concurrent),
        readsCompletedDuringProbe: readsDone,
        readLatency: stats(readLatencies),
      },
      null,
      2,
    ),
  );
  try {
    await writer.call("system.shutdown", {}, 5000);
  } catch {
    /* already closing */
  }
  writer.socket.destroy();
  reader.socket.destroy();
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  fs.rmSync(tmp, { recursive: true, force: true });
}
