#!/usr/bin/env node
// Perf driver: starts the real helper headless against a generated fixture and times
// socket operations from docs/architecture.md section 5.
//
// The fixture database is copied into a fresh temporary support folder on every run, so
// creates and saves during timing never pollute the fixture and a rerun sees the same data.
// OVERNOTE_BACKUP_DIR always points inside that temporary folder.
//
// Usage:
//   node scripts/perf/driver.mjs --fixture <dir> --helper <path> [--label 1000]
//     [--budgets scripts/perf/budgets.json] [--strict] [--reps N]
//
// Prints one JSON object on stdout and nothing else there. Progress goes to stderr.
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const fixtureDir = arg("fixture", null);
const helper = arg("helper", "assets/bin/OvernoteHelper");
const label = arg("label", path.basename(fixtureDir ?? "fixture"));
const budgetsPath = arg("budgets", null);
const strict = hasFlag("strict");
const repsScale = Number(arg("reps", "1"));
if (!fixtureDir) {
  console.error("driver: --fixture is required");
  process.exit(64);
}

const manifest = JSON.parse(fs.readFileSync(path.join(fixtureDir, "manifest.json"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "overnote-perf-"));
const support = path.join(tmp, "support");
const runDir = path.join(tmp, "run");
const backups = path.join(tmp, "backups");
fs.mkdirSync(support, { recursive: true });
fs.mkdirSync(runDir, { recursive: true });
fs.copyFileSync(path.join(fixtureDir, "support", "notes.sqlite"), path.join(support, "notes.sqlite"));
const socketPath = path.join(runDir, "helper.sock");
const pidFile = path.join(runDir, "helper.pid");

const nowMs = () => Date.now();
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return {
    n: s.length,
    minMs: round(s[0]),
    medianMs: round(pick(0.5)),
    p95Ms: round(pick(0.95)),
    maxMs: round(s.at(-1)),
    meanMs: round(mean),
  };
}
const round = (v) => Math.round(v * 1000) / 1000;

let child = null;
let client = null;

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
      const settle = pending.get(msg.id);
      pending.delete(msg.id);
      settle?.(msg);
    }
  });
  const call = (method, params = {}, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout ${method}`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(Object.assign(new Error(`${method}: ${msg.error.message}`), { code: msg.error.code }));
        else resolve(msg.result);
      });
      socket.write(JSON.stringify({ id, method, params }) + "\n");
    });
  const connected = new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return { socket, call, connected };
}

async function timed(fn) {
  const t0 = process.hrtime.bigint();
  const result = await fn();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, result };
}
async function repeat(n, fn) {
  const samples = [];
  for (let i = 0; i < n; i++) samples.push((await timed(() => fn(i))).ms);
  return stats(samples);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const env = { ...process.env, OVERNOTE_BACKUP_DIR: backups };
  const spawnT0 = process.hrtime.bigint();
  child = spawn(
    helper,
    [
      "--support-dir",
      support,
      "--socket",
      socketPath,
      "--pid-file",
      pidFile,
      "--editor-dir",
      path.join(tmp, "no-editor"),
      "--headless",
      "--test-hooks",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  child.stdout.on("data", (d) => {
    stderr += d;
  });

  // Startup: spawn to first successful system.ping from this process.
  let ping = null;
  let startupMs = null;
  const deadline = nowMs() + 20000;
  while (nowMs() < deadline) {
    if (child.exitCode !== null) throw new Error(`helper exited early ${child.exitCode}: ${stderr}`);
    if (fs.existsSync(socketPath)) {
      const probe = connect();
      try {
        await probe.connected;
        ping = await probe.call("system.ping");
        if (ping.pid === child.pid) {
          startupMs = Number(process.hrtime.bigint() - spawnT0) / 1e6;
          client = probe;
          break;
        }
      } catch {
        /* not ready yet */
      }
      probe.socket.destroy();
    }
    await sleep(25);
  }
  if (!client) throw new Error("helper never answered system.ping");
  const call = client.call;

  const status = await call("system.status");
  const countResult = await call("notes.count");
  if (countResult.count !== manifest.noteCount) {
    throw new Error(`count mismatch: helper sees ${countResult.count}, manifest says ${manifest.noteCount}`);
  }

  const R = (n) => Math.max(1, Math.round(n * repsScale));
  const ops = {};

  // Warmup, untimed.
  for (let i = 0; i < 3; i++) {
    await call("notes.browse", { limit: 100 });
    await call("notes.list", { limit: 100 });
    await call("notes.browse", { filter: manifest.search.sparseTerm, limit: 100 });
  }

  ops.startupToPing = {
    n: 1,
    medianMs: round(startupMs),
    p95Ms: round(startupMs),
    minMs: round(startupMs),
    maxMs: round(startupMs),
    meanMs: round(startupMs),
  };
  ops.browse = await repeat(R(30), () => call("notes.browse", { limit: 100 }));
  ops.browseFilteredSparse = await repeat(R(30), () =>
    call("notes.browse", { filter: manifest.search.sparseTerm, limit: 100 }),
  );
  ops.browseFilteredFolded = await repeat(R(30), () =>
    call("notes.browse", { filter: manifest.search.foldedTerm, limit: 100 }),
  );
  ops.list = await repeat(R(30), () => call("notes.list", { limit: 100 }));
  ops.listFilteredSparse = await repeat(R(30), () =>
    call("notes.list", { filter: manifest.search.sparseTerm, limit: 100 }),
  );
  ops.count = await repeat(R(30), () => call("notes.count"));
  ops.getFirst = await repeat(R(30), () => call("notes.get", { id: manifest.firstId }));

  // List paging: walk every page at limit 100, a few times. Per page and whole walk.
  const pageSamples = [];
  const walkSamples = [];
  for (let walk = 0; walk < R(3); walk++) {
    const t0 = process.hrtime.bigint();
    let cursor = undefined;
    let seen = 0;
    for (let page = 0; page < 10000; page++) {
      const one = await timed(() => call("notes.list", { limit: 100, ...(cursor ? { cursor } : {}) }));
      pageSamples.push(one.ms);
      seen += one.result.items.length;
      cursor = one.result.nextCursor;
      if (!cursor) break;
    }
    walkSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (seen !== manifest.noteCount) throw new Error(`paging saw ${seen}, expected ${manifest.noteCount}`);
  }
  ops.listPagingPerPage = stats(pageSamples);
  ops.listPagingFullWalk = stats(walkSamples);

  // Filtered paging sanity for the sparse term.
  const sparsePage = await call("notes.browse", { filter: manifest.search.sparseTerm, limit: 100 });
  const sparseExpectedMin = manifest.noteCount >= 100 ? 1 : 0;
  if (sparsePage.items.length < sparseExpectedMin)
    throw new Error(`sparse browse found ${sparsePage.items.length} notes`);
  // Title matches come before text only matches in a filtered browse.
  if (manifest.needleTitleId && !/quixotic/i.test(sparsePage.items[0]?.title ?? "")) {
    throw new Error(`sparse browse did not put a title match first: ${sparsePage.items[0]?.title}`);
  }

  // Create: small notes, timed individually.
  let createCounter = 0;
  ops.create = await repeat(R(20), async () => {
    const text = `Perf create ${label} ${createCounter++}\nbody created by the perf driver`;
    return call("notes.create", {
      rawContent: JSON.stringify({ type: "doc" }),
      markdown: text,
      text,
      title: text.split("\n")[0],
    });
  });

  // Debounced style save: mimic the editor session (SAVE_DEBOUNCE_MS is 300 in
  // editor/src/session/session.ts). Report the socket round trip alone and the
  // debounce inclusive wall time, so the 300 ms is never mistaken for helper cost.
  // A sacrificial note, so the save timings never rewrite a fixture note (in a large
  // fixture the first note is the large one, and shrinking it would fake its timings).
  const saveSeedText = "Perf save target\nseed body for debounced saves";
  const saveTarget = await call("notes.create", {
    rawContent: JSON.stringify({ type: "doc" }),
    markdown: saveSeedText,
    text: saveSeedText,
    title: "Perf save target",
  });
  let expected = saveTarget.updatedAt;
  const rpcSamples = [];
  const wallSamples = [];
  for (let i = 0; i < R(10); i++) {
    const wallT0 = process.hrtime.bigint();
    await sleep(300);
    const text = `Perf save ${i}\ndebounced save body ${i}`;
    const one = await timed(() =>
      call("notes.update", {
        id: saveTarget.id,
        expectedUpdatedAt: expected,
        rawContent: JSON.stringify({ type: "doc" }),
        markdown: text,
        text,
        title: text.split("\n")[0],
      }),
    );
    wallSamples.push(Number(process.hrtime.bigint() - wallT0) / 1e6);
    rpcSamples.push(one.ms);
    if (one.result.status !== "ok") throw new Error(`save ${i} conflicted`);
    expected = one.result.note.updatedAt;
  }
  ops.debouncedSaveRpc = stats(rpcSamples);
  ops.debouncedSaveWall = stats(wallSamples);

  // Large note operations, when this fixture carries one.
  if (manifest.largeNoteId) {
    ops.getLarge = await repeat(R(10), () => call("notes.get", { id: manifest.largeNoteId }));
    const large = await call("notes.get", { id: manifest.largeNoteId });
    let largeExpected = large.updatedAt;
    const largeRpc = [];
    for (let i = 0; i < R(5); i++) {
      const text = large.text.slice(0, -20) + `\nperf edit ${i} padpadpad`;
      const one = await timed(() =>
        call("notes.update", {
          id: manifest.largeNoteId,
          expectedUpdatedAt: largeExpected,
          rawContent: large.rawContent,
          markdown: text,
          text,
          title: large.title,
        }),
      );
      largeRpc.push(one.ms);
      if (one.result.status !== "ok") throw new Error(`large save ${i} conflicted`);
      largeExpected = one.result.note.updatedAt;
    }
    ops.updateLarge = stats(largeRpc);
    ops.browseWithLargePresent = await repeat(R(10), () => call("notes.browse", { limit: 100 }));
    ops.listWithLargePresent = await repeat(R(10), () => call("notes.list", { limit: 100 }));
  }

  ops.listDeleted = await repeat(R(10), () => call("notes.listDeleted"));

  const helperSha = crypto.createHash("sha256").update(fs.readFileSync(helper)).digest("hex");
  let helperVersion = "unknown";
  try {
    helperVersion = execFileSync(helper, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    /* keep unknown */
  }
  let schemaVersion = null;
  try {
    schemaVersion = Number(execFileSync(helper, ["--schema-version"], { encoding: "utf8" }).trim());
  } catch {
    /* keep null */
  }

  const result = {
    label,
    generatedAt: new Date().toISOString(),
    helper: { path: path.resolve(helper), version: helperVersion, schemaVersion, sha256: helperSha },
    machine: {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model ?? "unknown",
      cpuCount: os.cpus().length,
      totalMemBytes: os.totalmem(),
      loadavg: os.loadavg(),
      node: process.version,
    },
    fixture: manifest,
    status: { noteCount: status.noteCount, schemaVersion: status.schemaVersion },
    checks: { pagingSawAll: true, sparseBrowseItems: sparsePage.items.length, sparseExpectedMin },
    ops,
  };

  // Budget comparison. Budgets warn by default: the exit code only fails under --strict.
  if (budgetsPath && fs.existsSync(budgetsPath)) {
    const budgets = JSON.parse(fs.readFileSync(budgetsPath, "utf8"));
    result.budgetComparison = compareBudgets(result, budgets);
    for (const line of result.budgetComparison.lines) console.error(line);
    result.budgetVerdict = result.budgetComparison.verdict;
    if (strict && result.budgetVerdict === "FAIL") process.exitCode = 1;
  }

  console.log(JSON.stringify(result, null, 2));

  try {
    await call("system.shutdown", {}, 10000);
  } catch {
    /* helper may already be closing */
  }
  client.socket.destroy();
  await sleep(200);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function budgetFor(budgets, labelKey, op) {
  return budgets.scales?.[labelKey]?.[op] ?? budgets.scales?.default?.[op] ?? null;
}

function compareBudgets(result, budgets) {
  const lines = [];
  let verdict = "PASS";
  const mark = (level) => {
    if (level === "FAIL") verdict = "FAIL";
    else if (level === "WARN" && verdict === "PASS") verdict = "WARN";
  };
  for (const [op, stat] of Object.entries(result.ops)) {
    const budget = budgetFor(budgets, result.label, op);
    if (!budget) {
      lines.push(`[perf] SKIP ${op}: no budget for scale ${result.label}`);
      continue;
    }
    for (const metric of ["medianMs", "p95Ms"]) {
      const limit = budget[metric];
      if (limit == null) continue;
      const value = stat[metric];
      const failAt = limit * (budgets.failMultiplier ?? 2);
      if (value > failAt) {
        mark("FAIL");
        lines.push(
          `[perf] FAIL ${result.label} ${op} ${metric}=${value}ms budget=${limit}ms failAbove=${round(failAt)}ms`,
        );
      } else if (value > limit) {
        mark("WARN");
        lines.push(`[perf] WARN ${result.label} ${op} ${metric}=${value}ms budget=${limit}ms`);
      } else lines.push(`[perf] PASS ${result.label} ${op} ${metric}=${value}ms budget=${limit}ms`);
    }
  }
  lines.push(
    `[perf] budget verdict for ${result.label}: ${verdict}${strict ? " (strict)" : " (warn only, exit code stays 0)"}`,
  );
  return { verdict, lines };
}

main()
  // Exit 2 is a harness or helper failure; exit 1 is reserved for a FAIL budget under --strict.
  .catch((error) => {
    console.error(`[perf] driver failed: ${error.stack ?? error}`);
    process.exitCode = 2;
  })
  .finally(() => {
    try {
      if (child && child.exitCode === null) child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      client?.socket.destroy();
    } catch {
      /* already gone */
    }
    // Keep the temp folder only on failure, for the helper log.
    if (process.exitCode) console.error(`[perf] kept temp folder for inspection: ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  });
