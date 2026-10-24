/** Find and replace. */
import { expect, test } from "@playwright/test";
import { editor, openHarness } from "./harness";

test("find, navigate, replace all, and close", async ({ page }) => {
  await openHarness(page, ["Note one. NOTE two. note three. a.c abc"]);
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.press("Alt+Shift+ArrowRight");
  await page.keyboard.press("Meta+f");
  const input = page.getByTestId("find-input");
  await expect(input).toHaveValue("Note");
  await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
  await input.press("Enter");
  await expect(page.getByTestId("find-count")).toHaveText("2 of 3");
  await input.press("Shift+Enter");
  await input.press("Shift+Enter");
  await expect(page.getByTestId("find-count")).toHaveText("3 of 3");
  await expect(editor(page).locator(".find-match")).toHaveCount(3);

  await input.fill("a.c");
  await expect(page.getByTestId("find-count")).toHaveText("1 of 1");

  await input.fill("note");
  await page.getByRole("button", { name: "Show replace" }).click();
  await page.getByTestId("replace-input").fill("item");
  await page.getByTestId("replace-all").click();
  await expect(editor(page)).toHaveText("item one. item two. item three. a.c abc");
  await expect(page.getByTestId("find-count")).toHaveText("No results");

  await editor(page).focus();
  await page.keyboard.press("Meta+z");
  await expect(editor(page)).toHaveText("Note one. NOTE two. note three. a.c abc");

  await page.keyboard.press("Meta+f");
  await page.getByTestId("find-input").press("Escape");
  await expect(page.getByTestId("find-bar")).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
  await expect(page.getByTestId("app")).toBeVisible();
});

test("the count is blank without a term, reads No results without matches, and follows replace all", async ({
  page,
}) => {
  await openHarness(page, ["one two one"]);
  await page.keyboard.press("Meta+f");
  const count = page.getByTestId("find-count");
  await expect(count).toHaveText("");
  await expect(count).toHaveAttribute("role", "status");
  const input = page.getByTestId("find-input");
  await input.fill("one");
  await expect(count).toHaveText("1 of 2");
  await expect(editor(page).locator(".find-match.is-active")).toBeVisible();
  await input.fill("zzz");
  await expect(count).toHaveText("No results");
  await input.fill("one");
  await page.getByRole("button", { name: "Show replace" }).click();
  await page.getByTestId("replace-input").fill("x");
  await page.getByTestId("replace-all").click();
  await expect(count).toHaveText("No results");
  await input.fill("");
  await expect(count).toHaveText("");
});
