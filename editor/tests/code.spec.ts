/** Code blocks (spec/editor.md section 9). */
import { expect, test } from "@playwright/test";
import { blocks, docJSON, editor, openHarness } from "./harness";

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test("keys inside a code block", async ({ page }) => {
  await page.keyboard.type("```");
  await page.keyboard.press("Enter");
  await page.keyboard.type("a");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("b");
  let code = (await docJSON(page)).content?.[0];
  expect(code?.content?.[0]?.text).toBe("a\n\n\tb");
  await page.keyboard.press("Shift+Tab");
  code = (await docJSON(page)).content?.[0];
  expect(code?.content?.[0]?.text).toBe("a\n\nb");
  await expect(editor(page)).toBeFocused();

  await page.keyboard.press("Meta+a");
  const selected = await page.evaluate(() => getSelection()?.toString());
  expect(selected).toBe("a\n\nb");

  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Meta+Enter");
  await page.keyboard.type("after");
  expect(await blocks(page)).toEqual(["codeBlock", "paragraph"]);

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Shift+Enter");
  expect(await blocks(page)).toEqual(["codeBlock", "paragraph", "paragraph"]);
});

test("language picker, auto detection, and copy", async ({ page }) => {
  await page.keyboard.type("```");
  await page.keyboard.press("Enter");
  await page.keyboard.type("def f():\n    return 1");
  const block = editor(page).locator(".code-block");
  const select = block.locator("select");
  await expect(select.locator("option")).toHaveCount(32);
  await expect(select.locator("option").first()).toHaveText("Auto");
  await expect(block.locator(".hljs-keyword").first()).toBeVisible();
  expect((await docJSON(page)).content?.[0]?.attrs?.language).toBeNull();
  await block.hover();
  await select.selectOption("python");
  expect((await docJSON(page)).content?.[0]?.attrs?.language).toBe("python");
  await block.locator(".code-block-copy").click();
  await expect(block.locator(".code-block-copy")).toHaveText("Copied");
  const copies = await page.evaluate(() =>
    (window as unknown as { __betterNotesMock: { callsTo(m: string): { params: { text: string } }[] } }).__betterNotesMock.callsTo("clipboard.copy"),
  );
  expect(copies.at(-1)?.params.text).toBe("def f():\n    return 1");
});

test("Backspace in an empty code block makes a paragraph", async ({ page }) => {
  await page.keyboard.type("```js ");
  expect(await blocks(page)).toEqual(["codeBlock"]);
  await page.keyboard.press("Backspace");
  expect(await blocks(page)).toEqual(["paragraph"]);
});
