/** Code blocks: fences, the language picker, copy, and highlighting. */
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
    (window as unknown as { __overnoteMock: { callsTo(m: string): { params: { text: string } }[] } }).__overnoteMock.callsTo("clipboard.copy"),
  );
  expect(copies.at(-1)?.params.text).toBe("def f():\n    return 1");
});

test("highlighting waits for a pause in typing and ignores edits outside the block", async ({ page }) => {
  const highlight = () =>
    page.evaluate(() => {
      const view = (window as unknown as { __bnEditor: { state: { plugins: { key: string; getState(s: unknown): { stale: boolean } }[] } } }).__bnEditor;
      const plugin = view.state.plugins.find((p) => p.key.startsWith("noteHighlight$"))!;
      return { stale: plugin.getState(view.state).stale, tokens: document.querySelectorAll(".code-block [class*=hljs-]").length };
    });
  await page.keyboard.type("```python");
  await page.keyboard.press("Enter");
  await page.keyboard.type("return 1");
  // Typed text is only highlighted once typing pauses.
  await expect.poll(async () => (await highlight()).stale).toBe(false);
  const settled = await highlight();
  expect(settled.tokens).toBeGreaterThan(0);
  await expect(editor(page).locator(".hljs-keyword")).toHaveText("return");

  // Prose typed after the block leaves the highlighting untouched and owes no new pass.
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Meta+Enter");
  await page.keyboard.type("def notes about the code");
  expect(await highlight()).toEqual(settled);

  // A new line inside the block is highlighted after the next pause.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("import os");
  await expect(editor(page).locator(".hljs-keyword")).toHaveText(["return", "import"]);
  expect((await highlight()).stale).toBe(false);
});

test("Backspace in an empty code block makes a paragraph", async ({ page }) => {
  await page.keyboard.type("```js ");
  expect(await blocks(page)).toEqual(["codeBlock"]);
  await page.keyboard.press("Backspace");
  expect(await blocks(page)).toEqual(["paragraph"]);
});
