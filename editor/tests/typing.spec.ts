/** Typing and Markdown input rules, through the real editor. */
import { expect, test } from "@playwright/test";
import { blocks, calls, docJSON, editor, lastSave, openHarness } from "./harness";

test.beforeEach(async ({ page }) => {
  await openHarness(page);
});

test("block rules create headings, lists, quotes, code, and rules", async ({ page }) => {
  await expect(editor(page).locator("p.is-empty")).toHaveAttribute("data-placeholder", "Untitled");
  await page.keyboard.type("# One");
  await page.keyboard.press("Enter");
  await page.keyboard.type("#### four");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- bullet");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("5. five");
  await page.keyboard.press("Enter");
  await page.keyboard.type("six");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- [ ] task");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[x] done");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("> quoted");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("---");
  await page.keyboard.type("```js ");
  await page.keyboard.type("x");

  expect(await blocks(page)).toEqual([
    "heading",
    "paragraph",
    "list:bullet",
    "list:ordered",
    "list:ordered",
    "list:task",
    "list:task",
    "blockquote",
    "horizontalRule",
    "codeBlock",
  ]);
  const doc = await docJSON(page);
  expect(doc.content?.[1]?.content?.[0]?.text).toBe("#### four");
  expect(doc.content?.[3]?.attrs?.order).toBe(5);
  await expect(editor(page).locator(".prosemirror-flat-list[data-list-kind=ordered]").nth(1)).toHaveText("six");
  expect(doc.content?.[5]?.attrs).toMatchObject({ kind: "task", checked: false });
  expect(doc.content?.[6]?.attrs).toMatchObject({ kind: "task", checked: true });
  expect(doc.content?.[9]?.attrs?.language).toBe("js");
  await expect(page.getByTestId("title")).toHaveText("One");
});

test("list triggers change an item instead of nesting, and headings convert", async ({ page }) => {
  await page.keyboard.type("- item");
  await page.keyboard.press("Meta+ArrowLeft");
  await page.keyboard.type("[ ] ");
  expect(await blocks(page)).toEqual(["list:task"]);
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await page.keyboard.type("## lifted");
  expect(await blocks(page)).toEqual(["list:task", "heading"]);
  await page.keyboard.press("Meta+ArrowLeft");
  await page.keyboard.type("- ");
  expect(await blocks(page)).toEqual(["list:task", "list:bullet"]);
  await expect(editor(page).locator(".prosemirror-flat-list").nth(1)).toHaveText("lifted");
});

test("inline rules, links, autolinks, and typography", async ({ page }) => {
  await page.keyboard.type(
    "**bold** *it* ~~gone~~ `x` [Site](raycast.com) [bad](javascript:alert) [raw](data:text/html,hi) example.com ",
  );
  await page.keyboard.type('-- ... "hi" don\'t -> (c) ++u++');
  const paragraph = (await docJSON(page)).content?.[0];
  const marked = (type: string) =>
    paragraph?.content?.filter((n) => n.marks?.some((m) => m.type === type)).map((n) => n.text);
  expect(marked("bold")).toEqual(["bold"]);
  expect(marked("italic")).toEqual(["it"]);
  expect(marked("strike")).toEqual(["gone"]);
  expect(marked("code")).toEqual(["x"]);
  expect(marked("underline")).toEqual([]);
  const links = paragraph?.content?.filter((n) => n.marks?.some((m) => m.type === "link"));
  expect(links?.map((n) => [n.text, n.marks?.find((m) => m.type === "link")?.attrs?.href])).toEqual([
    ["Site", "https://raycast.com"],
    ["example.com", "https://example.com"],
  ]);
  const text = await editor(page).innerText();
  expect(text).toContain("[bad](javascript:alert)");
  expect(text).toContain("[raw](data:text/html,hi)");
  expect(text).toContain("— … “hi” don’t → ©");
  // Typing right after a link does not extend it.
  await page.keyboard.press("Enter");
  await page.keyboard.type("[Doc](docs.dev)after");
  const last = (await docJSON(page)).content?.at(-1)?.content ?? [];
  expect(last.map((n) => [n.text, n.marks?.some((m) => m.type === "link") ?? false])).toEqual([
    ["Doc", true],
    ["after", false],
  ]);
});

test("rules do not fire inside code", async ({ page }) => {
  await page.keyboard.type("```");
  await page.keyboard.press("Enter");
  await page.keyboard.type("# not **bold** -- ");
  const doc = await docJSON(page);
  expect(doc.content?.[0]?.type).toBe("codeBlock");
  expect(doc.content?.[0]?.content?.[0]?.text).toBe("# not **bold** -- ");
});

test("undo reverts an input rule, then single characters", async ({ page }) => {
  await page.keyboard.type("# ");
  await page.keyboard.press("Backspace");
  expect(await blocks(page)).toEqual(["paragraph"]);
  await expect(editor(page)).toHaveText("# ");
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("abc", { delay: 30 });
  await page.keyboard.press("Meta+z");
  await expect(editor(page)).toHaveText("ab");
});

test("emoji picker inserts Unicode emoji", async ({ page }) => {
  await page.keyboard.type("a:");
  await expect(page.getByTestId("emoji-picker")).toHaveCount(0);
  await page.keyboard.type(" :");
  const picker = page.getByTestId("emoji-picker");
  await expect(picker.getByRole("option")).toHaveCount(6);
  await expect(picker.getByRole("button", { name: "Open Emoji Picker" })).toBeVisible();
  await page.keyboard.type("smile");
  await expect(picker.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  const text = (await docJSON(page)).content?.[0]?.content?.[0]?.text ?? "";
  expect(text.startsWith("a: ")).toBe(true);
  expect(text).not.toContain("smile");
  expect(/\p{Extended_Pictographic}/u.test(text)).toBe(true);
  await page.keyboard.type(" :x");
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  expect(await calls(page, "window.hide")).toHaveLength(0);
});

test("an empty note: ghost title, hints that fade once, and the first line becomes the title", async ({ page }) => {
  const keys = page.getByTestId("empty-hints");
  const line = page.getByTestId("empty-hint");
  await expect(keys).toHaveText("/Blocks⌘KActions⌘PNotes");
  await expect(line).toHaveText("Start with a title, or just write.");
  await expect(editor(page).locator(":scope > p")).toHaveAttribute("data-placeholder", "Untitled");
  expect(await line.evaluate((el) => getComputedStyle(el).position)).toBe("absolute");
  const height = () => page.locator(".content-inner").evaluate((el) => el.getBoundingClientRect().height);
  const before = await height();

  await page.keyboard.type("Groceries");
  await expect(keys).toHaveAttribute("data-faded", "true");
  await expect(line).toHaveAttribute("data-faded", "true");
  await expect(editor(page).locator("h1")).toHaveText("Groceries");
  expect(await height()).toBe(before);
  await page.keyboard.press("Enter");
  await page.keyboard.type("milk");
  await expect(editor(page).locator(":scope > p")).toHaveText("milk");
  await expect.poll(async () => String((await lastSave(page)).markdown)).toBe("# Groceries\n\nmilk");
  const save = await lastSave(page);
  for (const field of ["rawContent", "markdown", "text"] as const) {
    expect(String(save[field])).not.toMatch(/Start with a title|Blocks|Actions/);
  }

  // Emptied again: the ghost title returns, the hints do not.
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Backspace");
  await expect(editor(page).locator(":scope > :first-child")).toHaveAttribute("data-placeholder", "Untitled");
  await expect(keys).toHaveAttribute("data-faded", "true");
});
