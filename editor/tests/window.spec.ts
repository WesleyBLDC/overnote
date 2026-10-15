/** Content-driven window height, zoom, the counter, and the format bar. */
import { expect, test } from "@playwright/test";
import { calls, editor, openHarness } from "./harness";

test("resize reports follow content and zoom", async ({ page }) => {
  await openHarness(page);
  const heights = async () => (await calls(page, "window.resize")).map((c) => Number(c.params.contentHeight));
  await expect.poll(async () => (await heights()).length).toBeGreaterThan(0);
  const start = (await heights()).at(-1) ?? 0;
  const appHeight = await page.getByTestId("app").evaluate((el) => Math.ceil(el.getBoundingClientRect().height));
  expect(start).toBe(appHeight);
  for (let i = 0; i < 5; i++) await page.keyboard.press("Enter");
  await expect.poll(async () => (await heights()).at(-1) ?? 0).toBeGreaterThan(start);
  const tall = (await heights()).at(-1) ?? 0;
  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => (await heights()).at(-1) ?? 0).toBeGreaterThan(tall);
  for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
  await page.keyboard.press("Meta+0");
  await expect.poll(async () => (await heights()).at(-1) ?? 0).toBe(start);
  // The top 12 points stay free of controls for the native drag strip.
  const buttonTop = await page.getByTestId("new-note").evaluate((el) => el.getBoundingClientRect().top - el.closest(".app")!.getBoundingClientRect().top);
  expect(buttonTop).toBeGreaterThanOrEqual(12);
});

test("counter switches between characters and words; format bar replaces it", async ({ page }) => {
  await openHarness(page);
  await page.keyboard.type("Hello world");
  await expect(page.getByTestId("counter")).toHaveText("11 characters");
  await page.getByTestId("counter").click();
  await expect(page.getByTestId("counter")).toHaveText("2 words");
  await expect.poll(async () => (await calls(page, "settings.set")).at(-1)?.params).toEqual({ countMode: "words" });

  await page.keyboard.press("Alt+Meta+Comma");
  const bar = page.getByTestId("format-bar");
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("counter")).toHaveCount(0);
  await page.keyboard.press("Meta+a");
  await bar.getByRole("button", { name: "Code (⌘E)" }).click();
  await expect(editor(page).locator("code")).toHaveText("Hello world");
  await expect(bar.getByRole("button", { name: "Code (⌘E)" })).toHaveAttribute("aria-pressed", "true");
  await bar.getByRole("button", { name: "List" }).click();
  await page.getByRole("menuitemcheckbox", { name: /Task List/ }).click();
  await expect(bar.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Alt+Meta+Comma");
  await expect(page.getByTestId("counter")).toBeVisible();
});

test("slash menu and link popover", async ({ page }) => {
  await openHarness(page);
  await page.keyboard.type("/");
  const menu = page.getByTestId("slash-menu");
  await expect(menu.getByRole("option")).toHaveText([
    "Heading 1⌥⌘1", "Heading 2⌥⌘2", "Heading 3⌥⌘3", "Bold⌘B", "Italic⌘I", "Strikethrough⇧⌘S", "Underline⌘U",
    "Code⌘E", "Code Block⌥⌘C", "Blockquote⇧⌘B", "Ordered List⇧⌘7", "Bullet List⇧⌘8", "Task List⇧⌘9",
  ]);
  await page.keyboard.type("todo");
  await expect(menu.getByRole("option").first()).toContainText("Task List");
  await page.keyboard.press("Enter");
  await expect(menu).toHaveCount(0);
  await expect(editor(page).locator("[data-list-kind=task]")).toHaveCount(1);
  await page.keyboard.type("see raycast");
  await page.keyboard.press("Meta+l");
  const popover = page.getByTestId("link-popover");
  await expect(popover).toHaveAttribute("data-mode", "edit");
  await page.keyboard.type("not a url");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("notices")).toContainText("Invalid link");
  await popover.getByRole("textbox").fill("raycast.com");
  await page.keyboard.press("Enter");
  await expect(editor(page).locator("a")).toHaveAttribute("href", "https://raycast.com");
  await editor(page).locator("a").click();
  await expect(popover).toHaveAttribute("data-mode", "view");
  await popover.getByRole("button", { name: "Unlink" }).click();
  await expect(editor(page).locator("a")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Meta+l");
  await expect(page.getByTestId("notices")).toContainText("Select text to add a link");
});
