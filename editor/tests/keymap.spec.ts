/** Window shortcuts and the ⌘K panel (spec/keymap.md sections 1 to 5, 8). */
import { expect, test } from "@playwright/test";
import { calls, clearCalls, editor, openHarness, storedNotes } from "./harness";

const title = (page: import("@playwright/test").Page) => page.getByTestId("title");

test("⌘K runs actions, ⌘N refuses a blank note, history goes back and forward", async ({ page }) => {
  await openHarness(page, ["Alpha"]);
  await page.keyboard.press("Meta+k");
  const panel = page.getByTestId("command-panel");
  await expect(panel).toBeVisible();
  await page.keyboard.type("new");
  await page.keyboard.press("Enter");
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("app")).not.toHaveAttribute("data-note-id", (await storedNotes(page)).find((n) => n.title === "Alpha")?.id ?? "");
  await expect(title(page)).toHaveText("Untitled");

  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("notices")).toContainText("You already have an empty note");
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("action-new")).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  await page.keyboard.type("Beta");
  await page.keyboard.press("Meta+BracketLeft");
  await expect(title(page)).toHaveText("Alpha");
  await page.keyboard.press("Meta+BracketRight");
  await expect(title(page)).toHaveText("Beta");
  await page.keyboard.press("Alt+Meta+ArrowDown");
  await expect(title(page)).toHaveText("Alpha");
  await page.keyboard.press("Alt+Meta+ArrowUp");
  await expect(title(page)).toHaveText("Beta");
});

test("⌘P browses, pins work with ⇧⌘P and ⌘1, ⌃X deletes", async ({ page }) => {
  await openHarness(page, ["One", "Two", "Three"]);
  await page.keyboard.press("Meta+p");
  const rows = page.getByTestId("browse-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Current");
  await page.keyboard.type("one");
  await expect(rows).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(title(page)).toHaveText("One");

  await page.keyboard.press("Meta+Shift+p");
  await expect(page.getByTestId("notices")).toContainText("Note pinned");
  await page.keyboard.press("Meta+BracketLeft");
  await expect(title(page)).toHaveText("Three");
  await page.keyboard.press("Meta+1");
  await expect(title(page)).toHaveText("One");
  await page.keyboard.press("Meta+0");
  await expect(title(page)).toHaveText("One");

  await page.keyboard.press("Control+x");
  await expect(page.getByTestId("notices")).toContainText("Note deleted");
  expect((await storedNotes(page)).find((n) => n.title === "One")?.deletedAt).not.toBeNull();
  await expect(title(page)).not.toHaveText("One");
  const currentTitle = await title(page).textContent();

  // Recently Deleted: a read-only preview with a Restore banner.
  const openDeleted = async () => {
    await page.keyboard.press("Meta+k");
    await page.keyboard.type("recently deleted");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("deleted-row")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("preview-banner")).toBeVisible();
    await expect(title(page)).toHaveText("One");
  };
  await openDeleted();
  await expect(editor(page)).toHaveAttribute("contenteditable", "false");
  await page.keyboard.type("typed");
  await expect(editor(page)).toHaveText("One");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("preview-banner")).toHaveCount(0);
  await expect(title(page)).toHaveText(currentTitle ?? "");
  expect((await calls(page, "window.hide")).length).toBe(0);

  await openDeleted();
  await editor(page).click();
  await page.getByTestId("confirm-dialog").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("preview-banner")).toHaveCount(0);
  await expect(title(page)).toHaveText("One");
  await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  expect((await storedNotes(page)).find((n) => n.title === "One")?.deletedAt).toBeNull();
  await page.keyboard.press("Meta+BracketLeft");
  await expect(title(page)).toHaveText(currentTitle ?? "");

  await page.keyboard.press("Control+Shift+x");
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("notices")).toContainText("All notes moved to Recently Deleted");
  const live = (await storedNotes(page)).filter((n) => n.deletedAt === null);
  expect(live).toHaveLength(1);
  expect(live[0]?.text).toBe("");
});

test("copy as, export, deeplink, and zoom", async ({ page }) => {
  await openHarness(page, ["# Report\n\nBody **text**"]);
  await clearCalls(page);
  await page.keyboard.press("Meta+Shift+c");
  await page.keyboard.type("markdown");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page, "clipboard.copy")).at(-1)?.params.text).toBe("# Report\n\nBody **text**");

  await editor(page).getByText("Body").click();
  await page.keyboard.press("Alt+Shift+ArrowLeft");
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("action-copyAs")).toHaveText(/Copy Selection As/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-panel")).toHaveCount(0);

  await page.keyboard.press("Meta+Shift+e");
  await expect(page.getByTestId("command-panel")).toHaveAttribute("data-view", "export");
  await page.keyboard.type("html");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page, "file.saveAs")).at(-1)?.params).toEqual({
    suggestedName: "Report.html",
    content: "<h1>Report</h1><p>Body <strong>text</strong></p>",
  });

  await page.keyboard.press("Meta+Shift+d");
  await expect.poll(async () => String((await calls(page, "clipboard.copy")).at(-1)?.params.text)).toMatch(/^raycast:\/\/extensions\/.+toggle-notes\?launchContext=/);

  const size = async () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  const base = await size();
  await page.keyboard.press("Meta+Equal");
  await expect(page.getByTestId("notices")).toContainText("Zoom 105%");
  expect(await size()).not.toBe(base);
  await expect.poll(async () => (await calls(page, "settings.set")).at(-1)?.params).toEqual({ zoom: 1.05 });
  await page.keyboard.press("Meta+0");
  await expect.poll(size).toBe(base);
});

test("Esc hides the panel window, or resigns focus with the setting on", async ({ page }) => {
  await openHarness(page, ["Text"]);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await calls(page, "window.hide")).length).toBe(1);
  await page.evaluate(() =>
    (window as unknown as { __betterNotesMock: { store: { handlers: Record<string, (p: unknown) => unknown> } } }).__betterNotesMock.store.handlers["settings.set"]?.({ escapeLosesFocus: true }),
  );
  await editor(page).focus();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await calls(page, "window.resignFocus")).length).toBe(1);
  expect((await calls(page, "window.hide")).length).toBe(1);
});
