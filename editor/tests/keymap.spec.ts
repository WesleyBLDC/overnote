/** Window shortcuts and the ⌘K panel. */
import { expect, test } from "@playwright/test";
import { calls, clearCalls, editor, emit, openHarness, storedNotes } from "./harness";

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

test("copy as, export, and zoom", async ({ page }) => {
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
    (window as unknown as { __overnoteMock: { store: { handlers: Record<string, (p: unknown) => unknown> } } }).__overnoteMock.store.handlers["settings.set"]?.({ escapeLosesFocus: true }),
  );
  await editor(page).focus();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await calls(page, "window.resignFocus")).length).toBe(1);
  expect((await calls(page, "window.hide")).length).toBe(1);
});

test("⌘K and ⌘P open inside a roomy window without resizing it and scroll within it", async ({ page }) => {
  await openHarness(page, ["Alpha", "Beta"]);
  await clearCalls(page);
  const temporaryReports = async () => (await calls(page, "window.resize")).filter((c) => c.params.temporary);
  const fitsInside = async () =>
    page.evaluate(() => {
      const app = document.querySelector("[data-testid=app]")!.getBoundingClientRect();
      const panel = document.querySelector("[data-testid=command-panel]")!.getBoundingClientRect();
      const list = document.querySelector("[data-testid=command-panel] .panel-list") as HTMLElement;
      return {
        inside: panel.top >= app.top && panel.bottom <= app.bottom && panel.left >= app.left && panel.right <= app.right,
        appHeight: app.height,
        scrolls: getComputedStyle(list).overflowY === "auto",
        overflowing: list.scrollHeight > list.clientHeight,
      };
    });

  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("command-panel")).toBeVisible();
  await page.waitForTimeout(250);
  expect(await temporaryReports()).toEqual([]);
  // The root list is longer than the panel, so it scrolls inside the window instead of growing it.
  expect(await fitsInside()).toEqual({ inside: true, appHeight: 560, scrolls: true, overflowing: true });
  await page.keyboard.press("Escape");

  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  await page.waitForTimeout(250);
  expect(await temporaryReports()).toEqual([]);
  expect(await fitsInside()).toMatchObject({ inside: true, appHeight: 560, scrolls: true });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  expect(await calls(page, "window.resize")).toEqual([]);
});

test("⌘W is left to the helper's menu item: the editor never swallows it", async ({ page }) => {
  await openHarness(page, ["Text"]);
  await page.evaluate(() => {
    const seen: boolean[] = [];
    (window as unknown as { __cmdW: boolean[] }).__cmdW = seen;
    window.addEventListener("keydown", (event) => {
      if (event.metaKey && event.code === "KeyW") seen.push(event.defaultPrevented);
    });
  });
  await editor(page).focus();
  await page.keyboard.press("Meta+w");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cmdW: boolean[] }).__cmdW)).toEqual([false]);
  await expect(editor(page)).toHaveText("Text");
  await expect(editor(page)).toBeFocused();
});

test("⇧⌘D and ⌘K copy the note deeplink; ⇧⌘L copies it for Create Quicklink", async ({ page }) => {
  await openHarness(page, ["# Report\n\nBody"]);
  const id = (await storedNotes(page))[0]!.id;
  const expected = `raycast://extensions/wesleybldc/overnote/toggle-notes?context=${encodeURIComponent(JSON.stringify({ id }))}`;
  const lastCopy = async () => (await calls(page, "clipboard.copy")).at(-1)?.params.text;

  await page.keyboard.press("Meta+Shift+d");
  await expect.poll(lastCopy).toBe(expected);
  await expect(page.getByTestId("notices")).toContainText("Copied deeplink");

  await clearCalls(page);
  await page.keyboard.press("Meta+Shift+l");
  await expect.poll(lastCopy).toBe(expected);
  await expect(page.getByTestId("notices")).toContainText("Open Create Quicklink in Raycast");
  // Raycast documents no prefilled Create Quicklink deeplink, so nothing is opened.
  expect(await calls(page, "app.openURL")).toEqual([]);

  for (const [query, action] of [
    ["deeplink", "action-deeplink"],
    ["quicklink", "action-quicklink"],
  ] as const) {
    await clearCalls(page);
    await page.keyboard.press("Meta+k");
    await page.keyboard.type(query);
    await expect(page.getByTestId(action)).toHaveClass(/is-selected/);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("command-panel")).toHaveCount(0);
    await expect.poll(lastCopy).toBe(expected);
  }
});

test("⌘, opens Settings: controls write through settings.set and follow settings.changed", async ({ page }) => {
  await openHarness(page, ["Settings note"]);
  await clearCalls(page);
  const sets = async () => (await calls(page, "settings.set")).map((c) => c.params);
  const panel = page.getByTestId("command-panel");
  const sw = (id: string) => page.getByTestId(`setting-${id}`).getByRole("switch");

  await page.keyboard.press("Meta+Comma");
  await expect(panel).toHaveAttribute("data-view", "settings");
  for (const id of ["escapeLosesFocus", "windowAutoSize", "hideWhileScreenSharing", "showFormatBar"]) {
    await expect(sw(id)).toHaveAttribute("aria-checked", "false");
  }

  // Clicks toggle and the UI follows at once.
  await page.getByTestId("setting-hideWhileScreenSharing").click();
  await expect.poll(sets).toEqual([{ hideWhileScreenSharing: true }]);
  await expect(sw("hideWhileScreenSharing")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("setting-showFormatBar").click();
  await expect.poll(async () => (await sets()).at(-1)).toEqual({ showFormatBar: true });
  await expect(page.getByTestId("format-bar")).toBeVisible();

  // Keyboard: search filters, Enter toggles, arrows step the zoom and pick the counter.
  await page.keyboard.type("escape");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await sets()).at(-1)).toEqual({ escapeLosesFocus: true });
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("zoom");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await sets()).at(-1)).toEqual({ zoom: 1.05 });
  await expect(page.getByTestId("zoom-value")).toHaveText("105%");
  await page.getByTestId("zoom-reset").click();
  await expect.poll(async () => (await sets()).at(-1)).toEqual({ zoom: 1 });
  await expect(page.getByTestId("zoom-reset")).toBeDisabled();
  await page.keyboard.press("Meta+a");
  await page.keyboard.type("counter");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await sets()).at(-1)).toEqual({ countMode: "words" });
  await expect(page.getByTestId("count-words")).toHaveAttribute("aria-checked", "true");

  // A change from elsewhere (settings.changed) shows up in the open view.
  const current = await page.evaluate(() => (window as unknown as { __overnoteMock: { store: { settings: object } } }).__overnoteMock.store.settings);
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await emit(page, "settings.changed", { ...current, windowAutoSize: true, zoom: 1.5, countMode: "characters" });
  await expect(sw("windowAutoSize")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("zoom-value")).toHaveText("150%");
  await expect(page.getByTestId("count-characters")).toHaveAttribute("aria-checked", "true");

  // Escape clears the search, then closes; ⌘K lists Settings… and pushes the same view.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("settings");
  await expect(page.getByTestId("action-settings")).toHaveText("Settings…");
  await page.keyboard.press("Enter");
  await expect(panel).toHaveAttribute("data-view", "settings");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-view", "root");
});
