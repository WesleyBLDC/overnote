/**
 * End-to-end: the extension's domain layer against the REAL helper binary
 * (assets/bin/OvernoteHelper, started with --headless and temp directories).
 * Run `npm run build:helper` first.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { highlightMarkdownMatches } from "@overnote/core/text";

import { contentFromMarkdown, duplicateContent } from "../api/content";
import { titleMatchesFirst } from "../domain/fold";
import { summaryTitle } from "../domain/format";
import { HelperLauncher } from "../domain/launcher";
import { resolvePaths, type HelperPaths } from "../domain/paths";
import { isProcessAlive, readPidFile, sleep, waitForExit } from "../domain/process";
import { ReadOnlyNotesDb } from "../domain/readonly-db";
import { RpcClient, RpcError } from "../domain/rpc-client";
import type { NoteSummary, RpcMethod, RpcParams, RpcResult } from "../domain/types";
import { shortTempDir } from "./helpers";

// OVERNOTE_HELPER_BIN points at another build, such as helper/.build/release/OvernoteHelper.
const REAL_HELPER = path.resolve(process.env.OVERNOTE_HELPER_BIN || "assets/bin/OvernoteHelper");
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
    root = shortTempDir("one2e-");
    process.env.OVERNOTE_BACKUP_DIR = path.join(root, "backups");
    const assets = path.join(root, "assets");
    fs.mkdirSync(path.join(assets, "bin"), { recursive: true });
    fs.mkdirSync(path.join(assets, "editor"), { recursive: true });
    fs.copyFileSync(REAL_HELPER, path.join(assets, "bin", "OvernoteHelper"));
    const sum = createHash("sha256").update(fs.readFileSync(REAL_HELPER)).digest("hex");
    fs.writeFileSync(path.join(assets, "bin", "OvernoteHelper.sha256"), `${sum}  OvernoteHelper\n`);
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
    await call("notes.setCurrentNote", { noteId: groceries });
    // Search Notes' Duplicate: the suffix goes into the copy's first line, so every field agrees.
    const source = await call("notes.get", { id: second });
    const copy = await call("notes.duplicate", { id: second, ...duplicateContent(source, " (Copy)") });
    expect(copy).toMatchObject({ title: "Second note (Copy)", pinned: null, caretPosition: 0 });
    expect(copy.markdown.split("\n")[0]).toBe("Second note (Copy)");
    expect(copy.text.split("\n")[0]).toBe("Second note (Copy)");
    expect((await call("notes.list", { filter: "note (copy" })).items.map((note) => note.id)).toEqual([copy.id]);
    // The next content write derives the title from the document again, and it stays suffixed.
    const edited = await call("notes.update", { id: copy.id, ...contentFromMarkdown(`${copy.markdown}\n\nmore`) });
    expect(edited.note.title).toBe("Second note (Copy)");
    expect(await rpcCode(call("notes.duplicate", { id: second, titleSuffix: " (Copy)" } as never))).toBe(-32602);
    expect((await call("notes.get", { id: second })).title).toBe("Second note");
    // A duplicate, like a create without show, leaves the note the panel opens on alone.
    expect((await call("notes.windowData", {})).current?.id).toBe(groceries);
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
    // Enough variety for every read path Search Notes takes without the helper: pins, LIKE
    // wildcards in the text, folded filters, and trash order.
    const wildcard = (await call("notes.create", contentFromMarkdown("Progress\n\n100% done_now"))).id;
    const pinned = (await call("notes.create", contentFromMarkdown("Pinned groceries"))).id;
    await call("notes.pin", { id: pinned });
    await call("notes.pin", { id: second });
    for (const markdown of ["Old trash", "New trash"]) {
      const { id } = await call("notes.create", contentFromMarkdown(markdown));
      await sleep(5);
      await call("notes.delete", { id });
    }
    const filters = ["GROCER", "cafe", "CAFÉ", "%", "_", "0% d", "   ", "nothing matches"];
    const live = await call("notes.list", {});
    const liveFiltered = await Promise.all(filters.map((filter) => call("notes.list", { filter })));
    const liveDeleted = await call("notes.listDeleted", {});
    expect(ids(live.items).slice(0, 2)).toEqual([pinned, second]);
    expect(ids(liveFiltered[3]?.items ?? [])).toEqual([wildcard]);
    expect(liveDeleted.items.map((note) => note.title)).toEqual(["New trash", "Old trash"]);
    const { pid } = await ensure();
    await launcher.stop(pid);
    expect(await waitForExit(pid, 3000)).toBe(true);
    expect(fs.existsSync(paths.socket)).toBe(false);
    expect(await launcher.ping(300)).toBeNull();

    const db = ReadOnlyNotesDb.open(paths.database);
    expect(db).not.toBeNull();
    try {
      expect(db?.list().items).toEqual(live.items);
      filters.forEach((filter, index) => {
        expect(ids(db?.list({ filter }).items ?? []), `filter ${JSON.stringify(filter)}`).toEqual(
          ids(liveFiltered[index]?.items ?? []),
        );
      });
      const paged: string[] = [];
      let cursor: string | undefined;
      do {
        const page = db?.list({ limit: 3, cursor });
        paged.push(...ids(page?.items ?? []));
        cursor = page?.nextCursor ?? undefined;
      } while (cursor);
      expect(paged).toEqual(ids(live.items));
      expect(db?.listDeleted()).toEqual(liveDeleted.items);
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
    // A condition wait with a generous bound: the old helper is up once it answers with its version.
    const deadline = Date.now() + 10_000;
    while ((await launcher.ping(200))?.version !== "0.0.0-old" && Date.now() < deadline) {
      await sleep(50);
    }
    expect((await launcher.ping())?.version).toBe("0.0.0-old");

    const result = await ensure();
    expect(result).toMatchObject({ started: true, version: realVersion });
    expect(result.pid).not.toBe(oldPid);
    expect(await waitForExit(oldPid, 3000)).toBe(true);
    // The notes from the steps above survived the replacement: cafe, second, and two from the read-only step.
    expect((await call("notes.count", {})).count).toBe(4);
  });
});

/** Starts the real helper by hand, detached, the way Overnote.app or a script would. */
function startHelperProcess(paths: HelperPaths, extra: string[]): number {
  const child = spawn(
    REAL_HELPER,
    ["--support-dir", paths.supportDir, "--socket", paths.socket, "--pid-file", paths.pidFile, "--headless", ...extra],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  return child.pid ?? 0;
}

describe("the shared data folder and the Overnote.app handover, against the real helper", () => {
  let root: string;
  let assets: string;
  const launchers: HelperLauncher[] = [];
  const pids = new Set<number>();

  const launcherFor = (support: string, legacy?: string) => {
    const paths = resolvePaths({
      supportPath: path.join(root, support),
      legacySupportPath: legacy && path.join(root, legacy),
      assetsPath: assets,
      runtimeRoot: root,
    });
    const launcher = new HelperLauncher({ paths, client: new RpcClient({ socketPath: paths.socket }) });
    launchers.push(launcher);
    return launcher;
  };
  const ensure = async (launcher: HelperLauncher) => {
    const result = await launcher.ensure({ headless: true });
    pids.add(result.pid);
    return result;
  };
  const waitForHost = async (launcher: HelperLauncher, host: string, pid: number) => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const ping = await launcher.ping(250);
      if (ping?.host === host && ping.pid === pid) return ping;
      if (Date.now() > deadline) throw new Error(`no ${host} helper with pid ${pid} answered`);
      await sleep(50);
    }
  };
  const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

  beforeAll(() => {
    root = shortTempDir("onapp-");
    process.env.OVERNOTE_BACKUP_DIR = path.join(root, "backups");
    assets = path.join(root, "assets");
    fs.mkdirSync(path.join(assets, "bin"), { recursive: true });
    fs.mkdirSync(path.join(assets, "editor"), { recursive: true });
    fs.copyFileSync(REAL_HELPER, path.join(assets, "bin", "OvernoteHelper"));
    fs.writeFileSync(path.join(assets, "bin", "OvernoteHelper.sha256"), `${sha(REAL_HELPER)}  OvernoteHelper\n`);
  });

  afterAll(() => {
    for (const launcher of launchers) launcher.client.close();
    for (const pid of pids) if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("copies the legacy database into the shared folder once and never touches the original", async () => {
    // A release before the shared folder: its notes live in the legacy folder.
    const old = launcherFor("legacy");
    const first = await ensure(old);
    expect(first).toMatchObject({ started: true, host: "extension" });
    await old.client.call("notes.create", contentFromMarkdown("From the old folder"));
    await old.stop(first.pid);
    const legacyDb = path.join(root, "legacy", "notes.sqlite");
    const before = sha(legacyDb);

    const shared = launcherFor("shared", "legacy");
    const migrated = await ensure(shared);
    expect((await shared.client.call("notes.list", {})).items.map((note) => note.title)).toEqual([
      "From the old folder",
    ]);
    await shared.client.call("notes.create", contentFromMarkdown("Written after the move"));
    await shared.stop(migrated.pid);

    // A second start finds the shared database and copies nothing again.
    const again = await ensure(shared);
    expect((await shared.client.call("notes.count", {})).count).toBe(2);
    await shared.stop(again.pid);
    expect(sha(legacyDb)).toBe(before);
    expect(fs.readFileSync(path.join(root, "shared", "helper.log"), "utf8")).toMatch(/Copied the notes from/);
  });

  it("reuses a running Overnote.app as it is, without a restart", async () => {
    const launcher = launcherFor("shared", "legacy");
    const appPid = startHelperProcess(launcher.paths, ["--app"]);
    pids.add(appPid);
    await waitForHost(launcher, "app", appPid);
    // No launch record names this helper, which would make the launcher replace one of its own.
    const result = await ensure(launcher);
    expect(result).toMatchObject({ started: false, pid: appPid, host: "app" });
    expect((await ensure(launcher)).pid).toBe(appPid);
    expect(isProcessAlive(appPid)).toBe(true);
    await launcher.client.call("system.shutdown", {});
    expect(await waitForExit(appPid, 5000)).toBe(true);
  });

  it("hands its legacy folder to an app that started first on an empty database, and never overwrites notes", async () => {
    // The old release's notes, written in the legacy folder.
    const old = launcherFor("legacy-late");
    const first = await ensure(old);
    await old.client.call("notes.create", contentFromMarkdown("Waiting in the old folder"));
    await old.stop(first.pid);

    // Overnote.app starts before the extension ever ran: it has no legacy folder, so it creates an
    // empty shared database. Its notes.changed events are readable through the test hooks.
    const launcher = launcherFor("shared-late", "legacy-late");
    const appPid = startHelperProcess(launcher.paths, ["--app", "--test-hooks"]);
    pids.add(appPid);
    await waitForHost(launcher, "app", appPid);
    expect((await launcher.client.call("notes.count", {})).count).toBe(0);

    // The extension's next command finds the app and hands it the legacy folder.
    expect(await ensure(launcher)).toMatchObject({ started: false, pid: appPid, host: "app" });
    expect((await launcher.client.call("notes.list", {})).items.map((note) => note.title)).toEqual([
      "Waiting in the old folder",
    ]);
    // test.events is a test hook, outside the typed protocol.
    const testHook = launcher.client.call.bind(launcher.client) as unknown as (
      method: string,
      params: object,
    ) => Promise<unknown>;
    const events = (await testHook("test.events", {})) as { event: string }[];
    expect(events.map((entry) => entry.event)).toContain("notes.changed");
    const backups = (await launcher.client.call("system.listBackups", {})).items;
    expect(backups.filter((backup) => backup.reason === "pre-import")).toHaveLength(1);

    // From now on the shared database holds notes, deleted ones count too, and nothing replaces it.
    const [imported] = (await launcher.client.call("notes.list", {})).items;
    await launcher.client.call("notes.delete", { id: imported?.id ?? "" });
    const again = await launcher.client.call("system.importLegacy", { dir: path.join(root, "legacy-late") });
    expect(again).toMatchObject({ imported: false, preImportBackup: null, noteCount: 0 });
    expect((await launcher.client.call("notes.listDeleted", {})).items).toHaveLength(1);
    await launcher.client.call("system.shutdown", {});
    expect(await waitForExit(appPid, 5000)).toBe(true);
  });

  it("imports at startup into a shared database an app left empty", async () => {
    const old = launcherFor("legacy-start");
    const first = await ensure(old);
    await old.client.call("notes.create", contentFromMarkdown("Carried at startup"));
    await old.stop(first.pid);

    // The app ran once and quit, leaving an empty shared database behind.
    const launcher = launcherFor("shared-start", "legacy-start");
    const appPid = startHelperProcess(launcher.paths, ["--app"]);
    pids.add(appPid);
    await waitForHost(launcher, "app", appPid);
    await launcher.client.call("system.shutdown", {});
    expect(await waitForExit(appPid, 5000)).toBe(true);
    expect(fs.existsSync(path.join(root, "shared-start", "notes.sqlite"))).toBe(true);

    // The extension's own helper gets --legacy-support-dir and treats empty as not migrated.
    const started = await ensure(launcher);
    expect(started).toMatchObject({ started: true, host: "extension" });
    expect((await launcher.client.call("notes.list", {})).items.map((note) => note.title)).toEqual([
      "Carried at startup",
    ]);
    await launcher.stop(started.pid);
    expect(fs.readFileSync(path.join(root, "shared-start", "helper.log"), "utf8")).toMatch(/Imported 1 note\(s\) from/);
  });

  it("an app start shuts down the extension's helper and takes over, on the same data", async () => {
    const launcher = launcherFor("shared", "legacy");
    const extension = await ensure(launcher);
    expect(extension).toMatchObject({ started: true, host: "extension" });
    const appPid = startHelperProcess(launcher.paths, ["--app"]);
    pids.add(appPid);
    expect(await waitForExit(extension.pid, 10_000)).toBe(true);
    await waitForHost(launcher, "app", appPid);
    expect((await launcher.client.call("notes.count", {})).count).toBe(2);
    // A second app start defers to the running app and exits.
    const second = startHelperProcess(launcher.paths, ["--app"]);
    expect(await waitForExit(second, 5000)).toBe(true);
    expect((await launcher.ping())?.pid).toBe(appPid);

    // Once the app quits, the extension starts its own helper again, on the same folder.
    await launcher.client.call("system.shutdown", {});
    expect(await waitForExit(appPid, 5000)).toBe(true);
    const after = await ensure(launcher);
    expect(after).toMatchObject({ started: true, host: "extension" });
    expect((await launcher.client.call("notes.count", {})).count).toBe(2);
    await launcher.stop(after.pid);
  });
});
