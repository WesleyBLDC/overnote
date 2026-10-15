/** Autosave, note creation, note switching, and outside changes (contract v2 editor-owned behavior). */
import { expect, test } from "@playwright/test";
import { calls, clearCalls, editor, emit, lastSave, openHarness, storedNotes } from "./harness";

test("an empty store gets a note, typing saves after about 300 ms with derived fields", async ({ page }) => {
  await openHarness(page);
  expect((await calls(page, "notes.create")).length).toBe(1);
  await clearCalls(page);
  await page.keyboard.type("Groceries");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- eggs");
  const typedAt = Date.now();
  const save = await lastSave(page);
  expect(Date.now() - typedAt).toBeGreaterThanOrEqual(250);
  expect(save).toMatchObject({ title: "Groceries", text: "Groceries\n\neggs", markdown: "Groceries\n\n- eggs" });
  expect(typeof save.expectedUpdatedAt).toBe("number");
  expect(JSON.parse(String(save.rawContent)).type).toBe("doc");
  expect((await calls(page, "notes.update")).filter((c) => "rawContent" in c.params).length).toBe(1);
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
  await openHarness(page, ["Draft"]);
  const [note] = await storedNotes(page);
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.type(" more");
  await emit(page, "window.didHide", {});
  await expect.poll(async () => (await storedNotes(page))[0]?.text).toBe("Draft more");

  await page.waitForTimeout(1100);
  await page.evaluate((id) => {
    const mock = (window as unknown as { __betterNotesMock: { store: { externalUpdate(id: string, c: object): void } } }).__betterNotesMock;
    mock.store.externalUpdate(id, {
      rawContent: JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "From outside" }] }] }),
      text: "From outside",
      title: "From outside",
      markdown: "From outside",
    });
  }, note?.id ?? "");
  await expect(editor(page)).toHaveText("From outside");

  const created = await page.evaluate(() => {
    const mock = (window as unknown as { __betterNotesMock: { store: { handlers: Record<string, (p: unknown) => unknown> } } }).__betterNotesMock;
    return mock.store.handlers["notes.create"]?.({ rawContent: "", markdown: "Fresh", text: "Fresh", title: "Fresh", show: true }) as { id: string };
  });
  await expect(page.getByTestId("app")).toHaveAttribute("data-note-id", created.id);
  await expect(editor(page)).toHaveText("Fresh");
});
