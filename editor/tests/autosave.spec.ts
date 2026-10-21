/** Autosave, note creation, note switching, and outside changes (the editor-owned behavior in docs/architecture.md section 5). */
import { expect, test, type Page } from "@playwright/test";
import { calls, clearCalls, editor, emit, lastSave, openHarness, pauseClock, storedNotes } from "./harness";

test("an empty store gets a note, typing saves after about 300 ms with derived fields", async ({ page }) => {
  // A paused fake clock makes the debounce exact instead of racing real time on slow machines.
  await page.clock.install();
  await openHarness(page);
  expect((await calls(page, "notes.create")).length).toBe(1);
  await pauseClock(page);
  await clearCalls(page);
  await page.keyboard.type("Groceries");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- eggs");
  const contentSaves = async () => (await calls(page, "notes.update")).filter((c) => "rawContent" in c.params);
  await page.clock.runFor(250);
  expect(await contentSaves()).toHaveLength(0);
  await page.clock.runFor(100);
  const save = await lastSave(page);
  expect(save).toMatchObject({ title: "Groceries", text: "Groceries\n\neggs", markdown: "Groceries\n\n- eggs" });
  expect(typeof save.expectedUpdatedAt).toBe("number");
  expect(JSON.parse(String(save.rawContent)).type).toBe("doc");
  expect(await contentSaves()).toHaveLength(1);
});

test("switching notes flushes the last keystroke and restores the caret", async ({ page }) => {
  await openHarness(page, ["First note", "Second note"]);
  const [second, first] = await storedNotes(page);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type("!");
  await emit(page, "note.open", { id: first?.id });
  await expect(page.getByTestId("title")).toHaveText("First note");
  expect((await storedNotes(page)).find((n) => n.id === second?.id)?.text).toBe("Second note!");
  await emit(page, "note.open", { id: second?.id });
  await expect(page.getByTestId("title")).toHaveText("Second note!");
  await page.keyboard.type("?");
  await expect(editor(page)).toHaveText("Second note!?");
  const touched = (await calls(page, "notes.touchAccessed")).map((c) => c.params.id);
  expect(touched).toEqual([first?.id, second?.id]);
});

test("hiding saves right away, outside changes rebase, note.new opens the new note", async ({ page }) => {
  await page.clock.install();
  await openHarness(page, ["Draft"]);
  const [note] = await storedNotes(page);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" more");
  await emit(page, "window.didHide", {});
  await expect.poll(async () => (await storedNotes(page))[0]?.text).toBe("Draft more");

  // Past the typing window (TYPING_WINDOW_MS), so the outside change applies instead of waiting.
  await page.clock.runFor(1100);
  await page.evaluate((id) => {
    const mock = (window as unknown as { __overnoteMock: { store: { externalUpdate(id: string, c: object): void } } })
      .__overnoteMock;
    mock.store.externalUpdate(id, {
      rawContent: JSON.stringify({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "From outside" }] }],
      }),
      text: "From outside",
      title: "From outside",
      markdown: "From outside",
    });
  }, note?.id ?? "");
  await expect(editor(page)).toHaveText("From outside");

  const created = await page.evaluate(() => {
    const mock = (
      window as unknown as { __overnoteMock: { store: { handlers: Record<string, (p: unknown) => unknown> } } }
    ).__overnoteMock;
    return mock.store.handlers["notes.create"]?.({
      rawContent: "",
      markdown: "Fresh",
      text: "Fresh",
      title: "Fresh",
      show: true,
    }) as { id: string };
  });
  await expect(page.getByTestId("app")).toHaveAttribute("data-note-id", created.id);
  await expect(editor(page)).toHaveText("Fresh");
});

test("a new editor build (development) saves the last keystroke, then reloads the page", async ({ page }) => {
  await openHarness(page, ["Draft"]);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" kept");
  // The in-memory mock does not survive the reload, so the page reports what was saved as it unloads.
  await page.evaluate(() => {
    const { notes } = (window as unknown as { __overnoteMock: { store: { notes: Map<string, { text: string }> } } })
      .__overnoteMock.store;
    window.addEventListener("pagehide", () => console.log(`saved-at-unload:${[...notes.values()][0]?.text}`));
  });
  const unloadReport = page.waitForEvent("console", (message) => message.text().startsWith("saved-at-unload:"));
  const reloaded = page.waitForEvent("load");
  await emit(page, "editor.willReload", {});
  expect((await unloadReport).text()).toBe("saved-at-unload:Draft kept");
  await reloaded;
});

test("a failed autosave says so once while saving keeps failing, and the next save recovers", async ({ page }) => {
  await page.clock.install();
  await openHarness(page, ["Draft"]);
  await pauseClock(page);
  const failNextSave = () =>
    page.evaluate(() => {
      (window as unknown as { __overnoteMock: { failNext: Record<string, number> } }).__overnoteMock.failNext[
        "notes.update"
      ] = 500;
    });
  const contentSaves = async () => (await calls(page, "notes.update")).filter((c) => "rawContent" in c.params).length;
  // Errors go to the assertive region, and no live region sits inside another (it would be read twice).
  const failures = page.getByRole("alert").getByText("Could not save note. Try again.");
  await page.keyboard.press("Meta+ArrowDown");

  await failNextSave();
  await page.keyboard.type(" one");
  await page.clock.runFor(350);
  await expect(failures).toHaveCount(1);
  const nestedRegions = await page.evaluate(
    () =>
      document.querySelectorAll(
        ":is([role=status], [role=alert], [aria-live]) :is([role=status], [role=alert], [aria-live])",
      ).length,
  );
  expect(nestedRegions).toBe(0);

  // Still failing: no second notice for the same problem.
  await failNextSave();
  await page.keyboard.type(" two");
  await page.clock.runFor(350);
  await expect.poll(contentSaves).toBe(2);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __overnoteMock: { failNext: object } }).__overnoteMock.failNext),
    )
    .toEqual({});
  await expect(failures).toHaveCount(1);

  // The edits were kept, so the next save writes all of them.
  await page.keyboard.type(" three");
  await page.clock.runFor(350);
  await expect.poll(async () => (await storedNotes(page))[0]?.text).toBe("Draft one two three");
});

/** Another writer (overnote-axi, a script) saves `paragraphs` into a note through the socket. */
async function outsideWrite(page: Page, id: string, paragraphs: string[], options: { announce: boolean }) {
  const content = {
    rawContent: JSON.stringify({
      type: "doc",
      content: paragraphs.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
    }),
    text: paragraphs.join("\n\n"),
    title: paragraphs[0] ?? "",
    markdown: paragraphs.join("\n\n"),
  };
  await page.evaluate(
    ([noteId, fields, announce]) => {
      const { store } = (
        window as unknown as {
          __overnoteMock: {
            store: {
              externalUpdate(id: string, c: object): void;
              handlers: Record<string, (p: unknown) => unknown>;
            };
          };
        }
      ).__overnoteMock;
      // externalUpdate also emits notes.changed; the bare handler is a write the editor hears nothing about.
      if (announce) store.externalUpdate(noteId, fields);
      else store.handlers["notes.update"]?.({ id: noteId, ...fields });
    },
    [id, content, options.announce] as const,
  );
  // The mock delivers events and replies on timers; well inside the 300 ms autosave debounce.
  await page.clock.runFor(50);
}

const contentSaves = async (page: Page) => (await calls(page, "notes.update")).filter((c) => "rawContent" in c.params);

const composing = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __bnEditor: { view: { composing: boolean } } }).__bnEditor.view.composing,
  );

/** Starts or ends an input method composition the way the browser announces one. */
const compose = (page: Page, type: "compositionstart" | "compositionend") =>
  page.evaluate((name) => {
    document.querySelector(".note-editor")?.dispatchEvent(new CompositionEvent(name, { bubbles: true, data: "" }));
  }, type);

const bothKept = (page: Page) =>
  page.getByTestId("notices").getByText("This note also changed elsewhere, so both versions were kept");

test("an outside change while typing is merged into the typing at once, and the caret stays", async ({ page }) => {
  await page.clock.install();
  await openHarness(page, ["Draft"]);
  await pauseClock(page);
  const [note] = await storedNotes(page);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" mine");
  // The autosave has not run yet when another writer appends a paragraph.
  await outsideWrite(page, note?.id ?? "", ["Draft", "From outside"], { announce: true });
  await expect(editor(page)).toHaveText("Draft mineFrom outside");
  await page.keyboard.type("!");
  await page.clock.runFor(400);
  await expect.poll(async () => (await storedNotes(page))[0]?.text).toBe("Draft mine!\n\nFrom outside");
  // One save, made against the outside version, so nothing was refused or overwritten.
  const saves = await contentSaves(page);
  expect(saves).toHaveLength(1);
  expect(saves[0]?.params.expectedUpdatedAt).not.toBe(note?.updatedAt);
  await expect(page.getByTestId("notices")).not.toContainText("both versions");
});

test("an outside change right after a save, while still typing, shows at once and is kept", async ({ page }) => {
  await page.clock.install();
  await openHarness(page, ["Draft"]);
  await pauseClock(page);
  const [note] = await storedNotes(page);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" mine");
  await page.clock.runFor(400);
  await expect.poll(async () => (await storedNotes(page))[0]?.text).toBe("Draft mine");
  // Saved, but still inside the typing window when the outside change lands.
  await outsideWrite(page, note?.id ?? "", ["Draft mine", "From outside"], { announce: true });
  await expect(editor(page)).toHaveText("Draft mineFrom outside");
  await page.keyboard.type("!");
  await page.clock.runFor(400);
  await expect.poll(async () => (await storedNotes(page))[0]?.text).toBe("Draft mine!\n\nFrom outside");
});

test("a save that meets an unannounced outside change merges it and retries, never overwriting it", async ({
  page,
}) => {
  await page.clock.install();
  await openHarness(page, ["Draft"]);
  await pauseClock(page);
  const [note] = await storedNotes(page);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" mine");
  await outsideWrite(page, note?.id ?? "", ["Draft", "From outside"], { announce: false });
  await page.clock.runFor(400);
  await expect.poll(async () => (await storedNotes(page))[0]?.text).toBe("Draft mine\n\nFrom outside");
  await expect(editor(page)).toHaveText("Draft mineFrom outside");
  // The first save was refused as stale; the retry saved the merge against the outside version.
  const saves = await contentSaves(page);
  expect(saves).toHaveLength(2);
  expect(saves[0]?.params.expectedUpdatedAt).toBe(note?.updatedAt);
  expect(saves[1]?.params.expectedUpdatedAt).not.toBe(note?.updatedAt);
});

test("when the typing and an outside change edit the same paragraph, both versions are kept", async ({ page }) => {
  await page.clock.install();
  await openHarness(page, ["Draft"]);
  await pauseClock(page);
  const [note] = await storedNotes(page);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" mine");
  await outsideWrite(page, note?.id ?? "", ["From outside"], { announce: true });
  await expect(editor(page)).toHaveText("Draft mineFrom outside");
  await expect(page.getByTestId("notices")).toContainText(
    "This note also changed elsewhere, so both versions were kept",
  );
  await page.clock.runFor(400);
  await expect.poll(async () => (await storedNotes(page))[0]?.text).toBe("Draft mine\n\nFrom outside");
});

test("when an outside change deletes the paragraph being typed in, the typing is kept without a notice", async ({
  page,
}) => {
  await page.clock.install();
  await openHarness(page, ["Draft\n\nSecond"]);
  await pauseClock(page);
  const [note] = await storedNotes(page);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" mine");
  await outsideWrite(page, note?.id ?? "", ["Draft"], { announce: true });
  await expect(editor(page)).toHaveText("DraftSecond mine");
  await page.clock.runFor(400);
  await expect.poll(async () => (await storedNotes(page))[0]?.text).toBe("Draft\n\nSecond mine");
  // Only one version of that paragraph exists, so the editor does not claim it kept two.
  await expect(page.getByTestId("notices")).not.toContainText("both versions");
});

test("an outside change during an input method composition waits until the composition ends", async ({ page }) => {
  await page.clock.install();
  await openHarness(page, ["Draft"]);
  await pauseClock(page);
  const [note] = await storedNotes(page);
  await compose(page, "compositionstart");
  expect(await composing(page)).toBe(true);
  // Replacing the document now would break the text being composed, so the merge waits.
  await outsideWrite(page, note?.id ?? "", ["Draft", "From outside"], { announce: true });
  await page.clock.runFor(500);
  await expect(editor(page)).toHaveText("Draft");
  await compose(page, "compositionend");
  await page.clock.runFor(200);
  expect(await composing(page)).toBe(false);
  await expect(editor(page)).toHaveText("DraftFrom outside");
});

test("a composition whose end never arrives holds a save for at most 5 s, and the edits stay for the next save", async ({
  page,
}) => {
  await page.clock.install();
  await openHarness(page, ["Other", "Draft"]);
  await pauseClock(page);
  const [draft, other] = await storedNotes(page);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" mine");
  // The compositionend for this composition is lost, so the editor believes it is still composing.
  await compose(page, "compositionstart");
  expect(await composing(page)).toBe(true);
  await outsideWrite(page, draft?.id ?? "", ["Draft", "From outside"], { announce: false });

  // Switching notes saves first; the save is refused as stale, and its merge waits for the composition.
  await emit(page, "note.open", { id: other?.id });
  await page.clock.runFor(1000);
  await expect(page.getByTestId("title")).toHaveText("Draft mine");
  // Past the cap the merge is skipped: the switch reports the unsaved edits instead of hanging.
  await page.clock.runFor(4500);
  await expect(page.getByRole("alert").getByText("Could not save note. Try again.")).toHaveCount(1);
  await expect(page.getByTestId("title")).toHaveText("Draft mine");
  await expect(editor(page)).toHaveText("Draft mine");
  expect((await storedNotes(page)).find((n) => n.id === draft?.id)?.text).toBe("Draft\n\nFrom outside");

  // Once the composition ends, the next save merges and keeps every keystroke and the outside change.
  await compose(page, "compositionend");
  await page.clock.runFor(100);
  expect(await composing(page)).toBe(false);
  await emit(page, "note.open", { id: other?.id });
  await page.clock.runFor(100);
  await expect(page.getByTestId("title")).toHaveText("Other");
  expect((await storedNotes(page)).find((n) => n.id === draft?.id)?.text).toBe("Draft mine\n\nFrom outside");
});

test("a window data reply older than the last save is not loaded over the editor", async ({ page }) => {
  await page.clock.install();
  await openHarness(page, ["Draft"]);
  await pauseClock(page);
  const [note] = await storedNotes(page);
  // A notes.windowData reply that the save below overtakes, as a slow reply would be.
  await page.evaluate((id) => {
    type Handler = (params: Record<string, unknown>) => unknown;
    const { store } = (window as unknown as { __overnoteMock: { store: { handlers: Record<string, Handler> } } })
      .__overnoteMock;
    const windowData = store.handlers["notes.windowData"] as Handler;
    const stale = windowData({ noteId: id });
    store.handlers["notes.windowData"] = () => {
      store.handlers["notes.windowData"] = windowData;
      return stale;
    };
  }, note?.id ?? "");
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" mine");
  await page.clock.runFor(400);
  await expect.poll(async () => (await storedNotes(page))[0]?.text).toBe("Draft mine");
  // Idle (past the typing window) with nothing unsaved, which is when a newer stored note reloads.
  await page.clock.runFor(1100);
  await emit(page, "notes.changed", { ids: [note?.id] });
  await page.clock.runFor(100);
  await expect(editor(page)).toHaveText("Draft mine");
  await page.keyboard.type("!");
  await page.clock.runFor(400);
  await expect.poll(async () => (await storedNotes(page))[0]?.text).toBe("Draft mine!");
  await expect(bothKept(page)).toHaveCount(0);
});

test("a save whose retries each keep both versions says so once", async ({ page }) => {
  await page.clock.install();
  await openHarness(page, ["Draft"]);
  await pauseClock(page);
  // Right before each of the editor's next two saves, another writer changes the same place as the
  // editor: first it rewrites the paragraph being typed in, then it adds a paragraph where the
  // editor's kept copy of that paragraph sits. Both merges keep both versions.
  await page.evaluate(() => {
    type Update = (params: Record<string, unknown>) => unknown;
    const { store } = (
      window as unknown as {
        __overnoteMock: {
          store: { handlers: Record<string, Update>; notes: Map<string, { rawContent: string; text: string }> };
        };
      }
    ).__overnoteMock;
    const update = store.handlers["notes.update"] as Update;
    let writes = 0;
    store.handlers["notes.update"] = (params) => {
      const note = store.notes.get(String(params.id));
      if ("rawContent" in params && note && writes < 2) {
        writes++;
        const doc = JSON.parse(note.rawContent) as { content: object[] };
        const paragraph = { type: "paragraph", content: [{ type: "text", text: `Outside ${writes}` }] };
        doc.content.splice(0, writes === 1 ? 1 : 0, paragraph);
        const text = writes === 1 ? "Outside 1" : `Outside ${writes}\n\n${note.text}`;
        update({ id: params.id, rawContent: JSON.stringify(doc), text, markdown: text, title: `Outside ${writes}` });
      }
      return update(params);
    };
  });
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" mine");
  await page.clock.runFor(350);
  // Two refused saves, each merge keeping both versions, then the third save goes through.
  await expect.poll(async () => (await contentSaves(page)).length).toBe(3);
  await expect.poll(async () => (await storedNotes(page))[0]?.text).toBe("Draft mine\n\nOutside 2\n\nOutside 1");
  await expect(bothKept(page)).toHaveCount(1);
});

test("a save that keeps meeting newer outside changes gives up after three tries, keeps the edits, and says so once", async ({
  page,
}) => {
  await page.clock.install();
  await openHarness(page, ["Draft"]);
  await pauseClock(page);
  // Another writer saves a new paragraph right before each of the editor's next three saves.
  await page.evaluate(() => {
    type Update = (params: Record<string, unknown>) => unknown;
    const { store } = (
      window as unknown as {
        __overnoteMock: {
          store: { handlers: Record<string, Update>; notes: Map<string, { rawContent: string; text: string }> };
        };
      }
    ).__overnoteMock;
    const update = store.handlers["notes.update"] as Update;
    let writes = 0;
    store.handlers["notes.update"] = (params) => {
      const note = store.notes.get(String(params.id));
      if ("rawContent" in params && note && writes < 3) {
        writes++;
        const doc = JSON.parse(note.rawContent) as { content: object[] };
        doc.content.push({ type: "paragraph", content: [{ type: "text", text: `Outside ${writes}` }] });
        const text = `${note.text}\n\nOutside ${writes}`;
        update({ id: params.id, rawContent: JSON.stringify(doc), text, markdown: text, title: "Draft" });
      }
      return update(params);
    };
  });
  const failures = page.getByRole("alert").getByText("Could not save note. Try again.");
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" mine");
  await page.clock.runFor(350);
  await expect.poll(async () => (await contentSaves(page)).length).toBe(3);
  await expect(failures).toHaveCount(1);
  // Each refused save merged the newer version in, but the edits themselves stay unsaved.
  await expect(editor(page)).toHaveText("Draft mineOutside 1Outside 2Outside 3");
  expect((await storedNotes(page))[0]?.text).toBe("Draft\n\nOutside 1\n\nOutside 2\n\nOutside 3");

  // The next save, against the last version it merged, goes through.
  await page.keyboard.type("!");
  await page.clock.runFor(350);
  await expect
    .poll(async () => (await storedNotes(page))[0]?.text)
    .toBe("Draft mine!\n\nOutside 1\n\nOutside 2\n\nOutside 3");
  expect(await contentSaves(page)).toHaveLength(4);
  await expect(failures).toHaveCount(1);
});

test("undo after an outside change merged in place reverts only the person's typing", async ({ page }) => {
  await page.clock.install();
  await openHarness(page, ["Draft"]);
  await pauseClock(page);
  const [note] = await storedNotes(page);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" mine");
  await outsideWrite(page, note?.id ?? "", ["Draft", "From outside"], { announce: true });
  await expect(editor(page)).toHaveText("Draft mineFrom outside");
  // The merge is not an undo step of its own: undo takes back the typing and keeps the outside change.
  await page.keyboard.press("Meta+z");
  await expect(editor(page)).toHaveText("DraftFrom outside");
  await page.keyboard.press("Meta+z");
  await expect(editor(page)).toHaveText("DraftFrom outside");
  await page.keyboard.press("Meta+Shift+z");
  await expect(editor(page)).toHaveText("Draft mineFrom outside");
});
