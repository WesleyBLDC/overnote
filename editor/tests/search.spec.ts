/** Search (board 07): notes and actions in one box, the key actions, and its keys. */
import { expect, test } from "@playwright/test";
import { calls, openHarness, storedNotes } from "./harness";

test("Search: matches with actions and New note, > and the Actions token, submenus, ⌘↩ and ⌘⌫", async ({ page }) => {
  await openHarness(page, [
    "Duplicate detection\n\nHash each row",
    "Ops checklist\n\nremove dupes before export",
    "Weekly plan",
  ]);
  await page.keyboard.press("Meta+p");
  const panel = page.getByTestId("command-panel");
  const search = page.locator(".panel-search");
  await expect(page.getByTestId("key-actions")).toBeVisible();

  // Typing hides the key actions; notes come first with matches marked, then matching actions, then New note.
  await page.keyboard.type("dup");
  await expect(page.getByTestId("key-actions")).toHaveCount(0);
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  await expect(page.getByTestId("browse-row").first().locator(".search-match")).toHaveText("Dup");
  await expect(page.getByTestId("browse-row").nth(1)).toContainText("…remove dupes before export");
  await expect(page.getByTestId("action-duplicate")).toBeVisible();
  await expect(page.getByTestId("search-create")).toHaveText(/New note “dup”/);
  await expect(page.getByTestId("search-preview")).toContainText("Hash each row");

  // ⌘↩ makes a note that starts with the query.
  await page.keyboard.press("Meta+Enter");
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => (await storedNotes(page)).map((n) => n.title)).toContain("dup");

  // ">" switches to All actions; Backspace on the empty field goes back to notes.
  await page.keyboard.press("Meta+p");
  await page.keyboard.type(">");
  await expect(panel).toHaveAttribute("data-view", "root");
  await expect(page.getByTestId("search-token")).toHaveText("Actions");
  await expect(search).toHaveValue("");
  await page.keyboard.press("Backspace");
  await expect(panel).toHaveAttribute("data-view", "browse");

  // → opens the highlighted submenu, ↩ runs its action. (⌘K while Search is open closes it.)
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+k");
  await page.getByTestId("submenu-zoom").hover();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("[data-testid=search-submenu] .is-selected")).toHaveText(/Zoom In/);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await calls(page, "settings.set")).at(-1)?.params).toEqual({ zoom: 1.05 });

  // ⌘⌫ deletes the highlighted note, and the list refreshes. (The pointer leaves the list, so hover selects nothing.)
  await page.mouse.move(0, 0);
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("ops");
  await expect(page.getByTestId("browse-row")).toHaveCount(1);
  await page.keyboard.press("Meta+Backspace");
  await expect
    .poll(async () => (await storedNotes(page)).find((n) => n.title === "Ops checklist")?.deletedAt)
    .not.toBeNull();

  // On a narrow panel the submenu takes the list's place; ← goes back. (Esc clears the query, then closes.)
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await page.evaluate(() => (document.getElementById("root")!.style.width = "480px"));
  await page.keyboard.press("Meta+k");
  await page.getByTestId("submenu-window").click();
  await expect(page.getByTestId("action-fillLeft")).toBeVisible();
  await expect(page.getByTestId("action-duplicate")).toBeHidden();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("action-duplicate")).toBeVisible();
  await expect(page.getByTestId("action-fillLeft")).toBeHidden();
});

test("Search sort: the pill's menu orders notes, the meta line follows it and persists; snippets come from the helper", async ({
  page,
}) => {
  const filler = "lorem ipsum ".repeat(30);
  await openHarness(page, ["Banana bread\n\none two three", `Apple notes\n\n${filler}the deep marker here`, "Cherry"]);
  await page.mouse.move(0, 0);
  await page.keyboard.press("Meta+p");
  const pill = page.getByTestId("search-sort");
  const titles = page.getByTestId("browse-row").locator(".panel-row-title");
  const metas = page.getByTestId("browse-row").locator(".panel-row-subtitle");
  await expect(pill).toHaveText("Modified ▾");
  await expect(metas).toHaveText([
    "Current · edited just now",
    "Edited just now · 66 words",
    "Edited just now · 5 words",
  ]);

  // Title runs A to Z, and the choice is stored as the searchSort setting.
  await pill.click();
  await page.getByRole("menuitemcheckbox", { name: "Title" }).click();
  await expect(pill).toHaveText("Title ▾");
  await expect(titles).toHaveText(["Apple notes", "Banana bread", "Cherry"]);
  await expect
    .poll(async () => (await calls(page, "settings.set")).at(-1)?.params)
    .toEqual({ searchSort: { field: "title", direction: "asc", pinnedFirst: true } });

  // Length puts the longest first and leads the meta line with the word count; the toggle reverses it in place.
  await pill.click();
  await page.getByRole("menuitemcheckbox", { name: "Length" }).click();
  await expect(titles).toHaveText(["Apple notes", "Banana bread", "Cherry"]);
  await expect(metas.first()).toHaveText("66 words · Edited just now");
  await pill.click();
  await page.getByRole("menuitemcheckbox", { name: "Longest first" }).click();
  await expect(titles).toHaveText(["Cherry", "Banana bread", "Apple notes"]);
  await expect(metas.first()).toHaveText("Current · 1 word");
  await page.keyboard.press("Escape");
  await expect(page.locator(".menu")).toHaveCount(0);

  // Created reads as a date; the sort survives closing Search.
  await pill.click();
  await page.getByRole("menuitemcheckbox", { name: "Created" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
  await page.keyboard.press("Meta+p");
  await expect(pill).toHaveText("Created ▾");
  await expect(metas.nth(1)).toHaveText(/^Created [A-Z][a-z]{2} \d{1,2} · \d+ words$/);

  // A match past the row's preview still shows the passage around it, from the helper's snippet.
  await page.keyboard.type("marker");
  await expect(metas).toHaveText(["…the deep marker here"]);
  await expect(metas.first().locator(".search-match")).toHaveText("marker");
});
