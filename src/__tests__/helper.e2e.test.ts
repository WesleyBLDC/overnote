/**
 * End-to-end: the extension's domain layer against the REAL helper binary
 * (assets/bin/OvernoteHelper, started with --headless and temp directories).
 * Run `npm run build:helper` first.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { highlightMarkdownMatches } from "@overnote/core/text";

import { contentFromMarkdown } from "../api/content";
import { titleMatchesFirst } from "../domain/fold";
import { summaryTitle } from "../domain/format";
import { HelperLauncher } from "../domain/launcher";
import { resolvePaths, type HelperPaths } from "../domain/paths";
import { isProcessAlive, readPidFile, sleep, waitForExit } from "../domain/process";
import { ReadOnlyNotesDb } from "../domain/readonly-db";
import { RpcClient, RpcError } from "../domain/rpc-client";
import type { NoteSummary, RpcMethod, RpcParams, RpcResult } from "../domain/types";
import { shortTempDir } from "./helpers";

const REAL_HELPER = path.resolve("assets/bin/OvernoteHelper");
const FAKE_HELPER = path.resolve("src/__tests__/fixtures/fake-helper.mjs");

if (!fs.existsSync(REAL_HELPER)) {
  throw new Error(`${REAL_HELPER} is missing: run \`npm run build:helper\` before the end-to-end tests`);
}

const ids = (items: NoteSummary[]) => items.map((note) => note.id);

async function rpcCode(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof RpcError ? error.code : -1;
  }
}

describe("extension domain layer against the real helper", () => {
  let root: string;
  let paths: HelperPaths;
  let launcher: HelperLauncher;
  let realVersion: string;
  const headless = { headless: true };

  const ensure = () => launcher.ensure(headless);
  const call = async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> =>
    (await ensure()).client.call(method, params);

  beforeAll(() => {
    root = shortTempDir("bne2e-");
    const assets = path.join(root, "assets");
    fs.mkdirSync(path.join(assets, "bin"), { recursive: true });
    fs.mkdirSync(path.join(assets, "editor"), { recursive: true });
    fs.copyFileSync(REAL_HELPER, path.join(assets, "bin", "OvernoteHelper"));
    fs.copyFileSync(`${REAL_HELPER}.sha256`, path.join(assets, "bin", "OvernoteHelper.sha256"));
    paths = resolvePaths({ supportPath: path.join(root, "support"), assetsPath: assets, runtimeRoot: root });
    launcher = new HelperLauncher({ paths, client: new RpcClient({ socketPath: paths.socket }) });
    realVersion = execFileSync(REAL_HELPER, ["--version"], { encoding: "utf8" }).trim();
  });

  afterAll(async () => {
    const pid = await readPidFile(paths.pidFile).catch(() => null);
    if (pid !== null && isProcessAlive(pid)) await launcher.stop(pid).catch(() => process.kill(pid, "SIGKILL"));
    launcher.client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("launches the helper once and reuses it", async () => {
    const first = await ensure();
    expect(first).toMatchObject({ started: true, version: realVersion });
    expect(await readPidFile(paths.pidFile)).toBe(first.pid);
    const second = await ensure();
    expect(second).toMatchObject({ started: false, pid: first.pid });
  });

  let cafe: string;
  let second: string;
  let groceries: string;

  it("creates notes from markdown built by core, then lists and filters them", async () => {
    // Notes created in the same millisecond tie on updatedAt and fall back to id order, so space
    // them out the way a person would.
    cafe = (await call("notes.create", contentFromMarkdown("# Café list\n\n- milk\n- eggs"))).id;
    await sleep(5);
    second = (await call("notes.create", contentFromMarkdown("Second note"))).id;
    await sleep(5);
    groceries = (await call("notes.create", contentFromMarkdown("Groceries\n\nAsk about the cafe hours"))).id;

    const created = await call("notes.get", { id: cafe });
    expect(created).toMatchObject({ title: "Café list", deletedAt: null, pinned: null });
    expect(created.markdown).toContain("Café list");

    const all = await call("notes.list", {});
    expect(ids(all.items)).toEqual([groceries, second, cafe]);
    expect(all.items.find((note) => note.id === cafe)?.charCount).toBe(Array.from(created.text).length);

    const filtered = await call("notes.list", { filter: "CAFE" });
    expect(ids(filtered.items).sort()).toEqual([cafe, groceries].sort());
    expect(ids(titleMatchesFirst(filtered.items, "CAFE", summaryTitle))).toEqual([cafe, groceries]);
    // The detail pane bolds the matches in the stored markdown, as Search Notes renders it.
    expect(highlightMarkdownMatches(created.markdown, "CAFE")).toBe(created.markdown.replace("Café", "**Café**"));

    const page1 = await call("notes.list", { limit: 2 });
    const page2 = await call("notes.list", { limit: 2, cursor: page1.nextCursor ?? undefined });
    expect([...ids(page1.items), ...ids(page2.items)]).toEqual([groceries, second, cafe]);
    expect(page2.nextCursor).toBeNull();
  });

  it("answers many concurrent calls on one connection", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => call("notes.count", {})));
    expect(new Set(results.map((result) => result.count))).toEqual(new Set([3]));
  });

  it("pins, moves pins, and duplicates with a title suffix", async () => {
    await call("notes.pin", { id: second });
    await call("notes.pin", { id: cafe });
    expect(ids((await call("notes.list", {})).items)).toEqual([second, cafe, groceries]);

    await call("notes.movePinnedUp", { id: cafe });
    expect(ids((await call("notes.list", {})).items)).toEqual([cafe, second, groceries]);
    await call("notes.movePinnedDown", { id: second });
    expect(ids((await call("notes.list", {})).items)).toEqual([cafe, second, groceries]);

    expect(await rpcCode(call("notes.movePinnedUp", { id: groceries }))).toBe(409);

    await call("notes.unpin", { id: second });
    const copy = await call("notes.duplicate", { id: second, titleSuffix: " (Copy)" });
    expect(copy).toMatchObject({ title: "Second note (Copy)", pinned: null });
    // Remove the copy again so later steps see the original three notes.
    await call("notes.delete", { id: copy.id });
    await call("notes.permanentlyDelete", { id: copy.id });
  });

  it("deletes to the trash, recovers, and permanently deletes", async () => {
    await call("notes.delete", { id: cafe });
    expect(ids((await call("notes.list", {})).items)).not.toContain(cafe);
    const trash = await call("notes.listDeleted", {});
    expect(ids(trash.items)).toEqual([cafe]);
    expect(trash.items[0]?.markdown).toContain("Café list");

    const recovered = await call("notes.recover", { id: cafe });
    expect(recovered).toMatchObject({ deletedAt: null, pinned: null });

    await call("notes.permanentlyDelete", { id: groceries });
    expect((await call("notes.get", { id: groceries })).deletedAt).toBeNull();

    await call("notes.delete", { id: groceries });
    await call("notes.permanentlyDelete", { id: groceries });
    expect(await rpcCode(call("notes.get", { id: groceries }))).toBe(404);
    expect((await call("notes.listDeleted", {})).items).toEqual([]);
  });

  it("returns the contract error codes", async () => {
    expect(await rpcCode(call("notes.get", { id: "missing" }))).toBe(404);
    expect(await rpcCode(call("notes.pin", { id: "missing" }))).toBe(404);
    expect(await rpcCode(call("notes.get", {} as never))).toBe(-32602);
    expect(await rpcCode(call("notes.search" as never, {} as never))).toBe(-32601);
  });

  it("serves the same rows from the read-only database after shutdown", async () => {
    const live = await call("notes.list", {});
    const filtered = await call("notes.list", { filter: "café" });
    const { pid } = await ensure();
    await launcher.stop(pid);
    expect(await waitForExit(pid, 3000)).toBe(true);
    expect(fs.existsSync(paths.socket)).toBe(false);
    expect(await launcher.ping(300)).toBeNull();

    const db = ReadOnlyNotesDb.open(paths.database);
    expect(db).not.toBeNull();
    try {
      expect(db?.list().items).toEqual(live.items);
      expect(ids(db?.list({ filter: "CAFE" }).items ?? [])).toEqual(ids(filtered.items));
      expect(db?.listDeleted()).toEqual([]);
      expect(db?.get(cafe)?.title).toBe("Café list");
    } finally {
      db?.close();
    }
  });

  it("replaces a running helper whose version differs from the bundled one", async () => {
    fs.mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    const old = spawn(
      process.execPath,
      [
        FAKE_HELPER,
        "--support-dir",
        path.join(root, "old-support"),
        "--socket",
        paths.socket,
        "--pid-file",
        paths.pidFile,
      ],
      { env: { ...process.env, FAKE_HELPER_VERSION: "0.0.0-old" }, stdio: "ignore" },
    );
    const oldPid = old.pid ?? 0;
    const deadline = Date.now() + 3000;
    while ((await launcher.ping(200))?.version !== "0.0.0-old" && Date.now() < deadline) {
      await sleep(50);
    }
    expect((await launcher.ping())?.version).toBe("0.0.0-old");

    const result = await ensure();
    expect(result).toMatchObject({ started: true, version: realVersion });
    expect(result.pid).not.toBe(oldPid);
    expect(await waitForExit(oldPid, 3000)).toBe(true);
    expect((await call("notes.count", {})).count).toBe(2);
  });
});
