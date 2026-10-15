/** Lists and tasks. */
import { expect, test, type Page } from "@playwright/test";
import { blocks, docJSON, editor, openHarness } from "./harness";

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
