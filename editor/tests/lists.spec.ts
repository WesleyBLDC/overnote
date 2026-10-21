/** Lists and tasks. */
import { expect, test, type Page } from "@playwright/test";
import { blocks, docJSON, editor, openHarness, storedNotes } from "./harness";

interface ListNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: ListNode[];
}

async function checkedStates(page: Page): Promise<boolean[]> {
  const out: boolean[] = [];
  const walk = (node: ListNode) => {
    if (node.type === "list" && node.attrs?.kind === "task") out.push(node.attrs.checked === true);
    node.content?.forEach(walk);
  };
  walk((await docJSON(page)) as ListNode);
  return out;
}

async function depthOf(page: Page, text: string): Promise<number> {
  let found = -1;
  const walk = (node: ListNode & { text?: string }, depth: number) => {
    if (node.text === text) found = depth;
    node.content?.forEach((child) =>
      walk(child as ListNode & { text?: string }, node.type === "list" ? depth + 1 : depth),
    );
  };
  walk((await docJSON(page)) as ListNode, 0);
  return found;
}

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test("Enter splits, leaves, and dedents list items", async ({ page }) => {
  await page.keyboard.type("[ ] one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  expect(await checkedStates(page)).toEqual([false, false]);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("nested");
  expect(await depthOf(page, "nested")).toBe(2);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  expect(await depthOf(page, "two")).toBe(1);
  await page.keyboard.type("back");
  expect(await depthOf(page, "back")).toBe(1);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("after");
  expect((await blocks(page)).at(-1)).toBe("paragraph");
});

test("Tab nests at most five levels and never leaves the editor", async ({ page }) => {
  await page.keyboard.type("- first");
  await page.keyboard.press("Tab");
  expect(await depthOf(page, "first")).toBe(1);
  await expect(editor(page)).toBeFocused();
  for (const word of ["a", "b", "c", "d", "e", "f"]) {
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.type(word);
  }
  expect(await depthOf(page, "e")).toBe(5);
  expect(await depthOf(page, "f")).toBe(5);
  await page.keyboard.press("Shift+Tab");
  expect(await depthOf(page, "f")).toBe(4);
  await expect(editor(page)).toBeFocused();
});

test("four ways to toggle tasks", async ({ page }) => {
  await page.keyboard.type("[ ] parent");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("child");
  const boxes = editor(page).locator("input[type=checkbox]");

  await boxes.nth(1).click();
  expect(await checkedStates(page)).toEqual([false, true]);
  await boxes.nth(0).click({ modifiers: ["Meta"] });
  expect(await checkedStates(page)).toEqual([true, true]);

  await editor(page).getByText("parent").click();
  await page.keyboard.press("Meta+Enter");
  expect(await checkedStates(page)).toEqual([false, true]);
  await page.keyboard.press("Meta+Shift+Enter");
  expect(await checkedStates(page)).toEqual([true, true]);
  await page.keyboard.press("Meta+Shift+Enter");
  expect(await checkedStates(page)).toEqual([false, false]);

  const parent = editor(page).locator(".prosemirror-flat-list[data-list-kind=task]").first();
  await boxes.nth(0).click();
  await expect(parent).toHaveAttribute("data-list-checked", "");
  const paragraph = parent.locator("> .list-content > p");
  await expect(paragraph).not.toHaveCSS("text-decoration-line", "line-through");
});

test("list toggles keep attributes and move items", async ({ page }) => {
  await page.keyboard.type("[x] done");
  await page.keyboard.press("Meta+Shift+8");
  expect(await blocks(page)).toEqual(["list:bullet"]);
  await page.keyboard.press("Meta+Shift+9");
  expect(await checkedStates(page)).toEqual([true]);
  await page.keyboard.press("Meta+Shift+7");
  expect(await blocks(page)).toEqual(["list:ordered"]);
  await page.keyboard.press("Meta+Shift+7");
  expect(await blocks(page)).toEqual(["paragraph"]);

  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("- a");
  await page.keyboard.press("Enter");
  await page.keyboard.type("b");
  await page.keyboard.press("Control+Meta+ArrowUp");
  await expect(editor(page).locator(".prosemirror-flat-list")).toHaveText(["b", "a"]);
});

/** What each list item's marker shows, in document order: the ordered number, or "" for other kinds. */
async function markers(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll(".note-editor .prosemirror-flat-list")].map((item) => {
      if (item.getAttribute("data-list-kind") !== "ordered") return "";
      return getComputedStyle(item, "::before").content.replace(/^"|"$/g, "");
    }),
  );
}

async function pasteText(page: Page, text: string): Promise<void> {
  await page.evaluate((plain) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", plain);
    const event = new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true });
    document.querySelector(".note-editor")?.dispatchEvent(event);
  }, text);
}

const OUTLINE = [
  "1. Demo",
  "2. Your solution",
  "   1. sub a",
  "      1. sub sub",
  "3. Edge cases",
  "   1. a",
  "   2. b",
  "   3. c",
  "4. Productionization",
  "   1. a",
  "   2. b",
  "   3. c",
  "   4. d",
].join("\n");

const OUTLINE_MARKERS = ["1.", "2.", "2.1", "2.1.1", "3.", "3.1", "3.2", "3.3", "4.", "4.1", "4.2", "4.3", "4.4"];

test("nested ordered items show their parent's number path, and Markdown keeps 1. numbering", async ({ page }) => {
  await pasteText(page, OUTLINE);
  await expect.poll(() => markers(page)).toEqual(OUTLINE_MARKERS);

  await expect.poll(async () => (await storedNotes(page))[0]?.markdown).toBe(OUTLINE);
  await page.keyboard.press("Meta+a");
  const copied = await page.evaluate(() => {
    const transfer = new DataTransfer();
    const event = new ClipboardEvent("copy", { clipboardData: transfer, bubbles: true, cancelable: true });
    document.querySelector(".note-editor")?.dispatchEvent(event);
    return { text: transfer.getData("text/plain"), html: transfer.getData("text/html") };
  });
  expect(copied.text).toBe(OUTLINE);
  expect(copied.html).not.toContain("3.1");
});

test("typed nested ordered items number the same way", async ({ page }) => {
  await page.keyboard.type("1. Demo");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Your solution");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("sub a");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("sub sub");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("Edge cases");
  for (const word of ["a", "b", "c"]) {
    await page.keyboard.press("Enter");
    if (word === "a") await page.keyboard.press("Tab");
    await page.keyboard.type(word);
  }
  await expect.poll(() => markers(page)).toEqual(["1.", "2.", "2.1", "2.1.1", "3.", "3.1", "3.2", "3.3"]);

  // Moving an item renumbers it under its new parent.
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => markers(page)).toEqual(["1.", "2.", "2.1", "2.1.1", "3.", "3.1", "3.2", "4."]);
});

test("an explicit start holds, and paths only follow ordered parents", async ({ page }) => {
  await pasteText(
    page,
    [
      "5. five",
      "6. six",
      "   1. inner",
      "",
      "Between.",
      "",
      "- bullet",
      "  1. one",
      "  2. two",
      "",
      "1. top",
      "   - nested bullet",
      "     1. under bullet",
      "   - [ ] task",
      "   3. three",
    ].join("\n"),
  );
  await expect.poll(() => markers(page)).toEqual(["5.", "6.", "6.1", "", "1.", "2.", "1.", "", "1.", "", "1.3"]);
});
