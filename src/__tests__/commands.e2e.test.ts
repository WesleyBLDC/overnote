/**
 * End-to-end: the Raycast commands (src/*.ts) and their data layer (src/api) against the REAL
 * helper. Only Raycast's own UI calls are stubbed (src/__mocks__). The "helper binary" here is a
 * wrapper that always adds --headless --test-hooks before the real one, so whatever a command asks
 * for, no panel ever opens on screen, and the test can read what the panel would show.
 * Run `npm run build:helper` first.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { environment, shown } from "../__mocks__/raycast-api";
import { getLauncher } from "../api/helper";
import { listDeletedNotes, listNotes } from "../api/notes";
import { loadMenuData } from "../api/menu-data";
import { showAndPlace } from "../api/window";
import CreateNote from "../create-note";
import OpenNotes from "../open-notes";
import ToggleNotes from "../toggle-notes";
import { readPidFile, waitForExit } from "../domain/process";
import { shortTempDir } from "./helpers";

// OVERNOTE_HELPER_BIN points at another build, such as helper/.build/release/OvernoteHelper.
const REAL_HELPER = path.resolve(process.env.OVERNOTE_HELPER_BIN || "assets/bin/OvernoteHelper");
if (!fs.existsSync(REAL_HELPER)) {
  throw new Error(`${REAL_HELPER} is missing: run \`npm run build:helper\` before the end-to-end tests`);
}

/** Launch props for a command: only the fields the command reads; Raycast fills in the rest. */
const props = (value: { arguments?: Record<string, string>; launchContext?: object }) =>
  ({ arguments: {}, ...value }) as never;

describe("Raycast commands against the real helper", () => {
  let root: string;
  const helper = () => getLauncher().client;
  const visible = async () => (await helper().call("test.visible" as never, {} as never)) as unknown as boolean;

  beforeAll(async () => {
    root = shortTempDir("oncmd-");
    const bin = path.join(root, "assets", "bin");
    fs.mkdirSync(bin, { recursive: true });
    const wrapper = path.join(bin, "OvernoteHelper");
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec '${REAL_HELPER}' "$@" --headless --test-hooks\n`, { mode: 0o755 });
    const sum = createHash("sha256").update(fs.readFileSync(wrapper)).digest("hex");
    fs.writeFileSync(`${wrapper}.sha256`, `${sum}  OvernoteHelper\n`);
    environment.supportPath = path.join(root, "support");
    environment.assetsPath = path.join(root, "assets");
    process.env.OVERNOTE_RUNTIME_DIR = path.join(root, "run");
  });

  afterAll(async () => {
    const pid = await readPidFile(path.join(root, "run", "helper.pid")).catch(() => null);
    if (pid !== null)
      await getLauncher()
        .stop(pid)
        .catch(() => process.kill(pid, "SIGKILL"));
    getLauncher().client.close();
    delete process.env.OVERNOTE_RUNTIME_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("Create Note starts the helper, stores the argument as a note, and shows it", async () => {
    await CreateNote(props({ arguments: { text: "# Groceries\n\n- milk" } }));
    expect(shown).toEqual([]);
    expect(await visible()).toBe(true);
    const [note] = await listNotes();
    expect(note).toMatchObject({ title: "Groceries" });
  });

  it("Open Overnote keeps the panel open, while Toggle Overnote hides it", async () => {
    await OpenNotes();
    await OpenNotes();
    expect(await visible()).toBe(true);
    await ToggleNotes(props({}));
    expect(await visible()).toBe(false);
    await OpenNotes();
    expect(await visible()).toBe(true);
    expect(shown).toEqual([]);
  });

  it("Search Notes, the menu bar, and Recently Deleted read what the helper stored", async () => {
    await CreateNote(props({ arguments: { text: "Pinned plan" } }));
    const pinned = (await listNotes("pinned plan"))[0];
    expect(pinned).toBeDefined();
    await helper().call("notes.pin", { id: pinned!.id });
    const trash = (await helper().call("notes.create", { rawContent: "", markdown: "Old", text: "Old", title: "Old" }))
      .id;
    await helper().call("notes.delete", { id: trash });

    const menu = await loadMenuData();
    expect(menu.pinned.map((n) => n.title)).toEqual(["Pinned plan"]);
    expect(menu.recent.map((n) => n.title)).toEqual(["Groceries"]);
    expect(menu.restoreAvailable).toBe(false);
    expect((await listDeletedNotes()).map((n) => n.title)).toEqual(["Old"]);
    expect((await listNotes("GROCER")).map((n) => n.title)).toEqual(["Groceries"]);
  });

  it("with the helper stopped, the lists read the database and never start it", async () => {
    const pid = (await getLauncher().ping())!.pid;
    await getLauncher().stop(pid);
    expect(await waitForExit(pid, 3000)).toBe(true);

    expect((await listNotes()).map((n) => n.title)).toEqual(["Pinned plan", "Groceries"]);
    expect((await listDeletedNotes()).map((n) => n.title)).toEqual(["Old"]);
    expect(await getLauncher().ping(300)).toBeNull();
  });

  it("the menu bar's Window items start a stopped helper, show the panel, then place it", async () => {
    expect(await getLauncher().ping(300)).toBeNull();
    const placed = await showAndPlace("left");
    // Headless, the recording host places against a 1440 x 875 display: x is the left edge, y the top edge.
    expect(placed).toEqual({ placement: "left", frame: { x: 0, y: 875, width: 720, height: 875 } });
    expect(await visible()).toBe(true);
  });
});
