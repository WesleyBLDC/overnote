/** Paste and copy. */
import { expect, test, type Page } from "@playwright/test";
import { blocks, docJSON, editor, openHarness } from "./harness";

async function paste(page: Page, data: Record<string, string>): Promise<void> {
  await page.evaluate((flavors) => {
    const transfer = new DataTransfer();
    for (const [type, value] of Object.entries(flavors)) transfer.setData(type, value);
    const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
    document.querySelector(".note-editor")?.dispatchEvent(event);
  }, data);
}

async function copySelection(page: Page): Promise<{ text: string; html: string }> {
  return page.evaluate(() => {
    const transfer = new DataTransfer();
    const event = new ClipboardEvent("copy", { clipboardData: transfer, bubbles: true, cancelable: true });
    document.querySelector(".note-editor")?.dispatchEvent(event);
    return { text: transfer.getData("text/plain"), html: transfer.getData("text/html") };
  });
}

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test("markdown text becomes blocks, lines become hard breaks", async ({ page }) => {
  await paste(page, { "text/plain": "# Title\n- item\n\nline one\nline two" });
  expect(await blocks(page)).toEqual(["heading", "list:bullet", "paragraph"]);
  const last = (await docJSON(page)).content?.[2];
  expect(last?.content?.map((n) => n.type)).toEqual(["text", "hardBreak", "text"]);
});

test("a URL links the selection or inserts a link", async ({ page }) => {
  await paste(page, { "text/plain": "https://raycast.com" });
  await page.keyboard.type(" word");
  let doc = await docJSON(page);
  expect(doc.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.href).toBe("https://raycast.com");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await paste(page, { "text/plain": "example.com" });
  doc = await docJSON(page);
  const word = doc.content?.[0]?.content?.find((n) => n.text === "word");
  expect(word?.marks?.[0]?.attrs?.href).toBe("https://example.com");
});

test("rich HTML keeps lists, code takes text literally, plain paste has no formatting", async ({ page }) => {
  await paste(page, { "text/plain": "a b", "text/html": "<ul><li>a</li><li>b</li></ul>" });
  expect(await blocks(page)).toEqual(["list:bullet", "list:bullet"]);
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("```");
  await page.keyboard.press("Enter");
  await paste(page, { "text/plain": "# not a heading" });
  expect((await docJSON(page)).content?.[0]?.content?.[0]?.text).toBe("# not a heading");
  await page.keyboard.press("Meta+Enter");
  await page.keyboard.press("Meta+Shift+v");
  await paste(page, { "text/plain": "**x**\n- y" });
  expect(await blocks(page)).toEqual(["codeBlock", "paragraph", "paragraph"]);
  await expect(editor(page).locator("p").last()).toHaveText("- y");
});

test("copy writes Markdown-like text and simple HTML", async ({ page }) => {
  await paste(page, { "text/plain": "## Hi\n- [x] Done" });
  await page.keyboard.press("Meta+a");
  const flavors = await copySelection(page);
  expect(flavors.text).toBe("## Hi\n\n- [x]  Done");
  expect(flavors.html).toBe('<h2>Hi</h2><ul><li><input type="checkbox" checked disabled>Done</li></ul>');
});
