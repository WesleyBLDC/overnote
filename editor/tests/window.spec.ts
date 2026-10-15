/** Window height, zoom, note text size, the title line, toolbar layout and drag regions, the accent, the counter, and the format bar. */
import { expect, test } from "@playwright/test";
import { calls, editor, lastSave, openHarness } from "./harness";

test("resize reports follow content, zoom, and overlays", async ({ page }) => {
  await openHarness(page);
  const reports = async () => (await calls(page, "window.resize")).map((c) => c.params as { contentHeight: number; temporary?: boolean });
  const last = async () => (await reports()).at(-1);
  const appHeight = () => page.getByTestId("app").evaluate((el) => el.getBoundingClientRect().height);

  // Auto-sizing is off by default: the panel opens roomy (560 points) and content is not reported.
  expect(await appHeight()).toBe(560);
  await page.waitForTimeout(200);
  expect(await reports()).toEqual([]);

  // With auto-sizing on, a one-line note is about 157 points (150% note text plus the title rule), footer at the bottom.
  await page.keyboard.press("Meta+Shift+Slash");
  await expect.poll(async () => (await reports()).length).toBeGreaterThan(0);
  const start = (await last())?.contentHeight ?? 0;
  expect(start).toBeGreaterThanOrEqual(150);
  expect(start).toBeLessThanOrEqual(162);
  await expect.poll(appHeight).toBe(start);
  const footerGap = await page.getByTestId("footer").evaluate((el) => el.closest(".app")!.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom);
  expect(footerGap).toBeLessThanOrEqual(1);

  for (let i = 0; i < 5; i++) await page.keyboard.press("Enter");
  await expect.poll(async () => (await last())?.contentHeight ?? 0).toBeGreaterThan(start + 150);
  const tall = (await last())?.contentHeight ?? 0;
  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => (await last())?.contentHeight ?? 0).toBeGreaterThan(tall);
  for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
  await page.keyboard.press("Meta+0");
  await expect.poll(async () => (await last())?.contentHeight ?? 0).toBe(start);

  // ⌘K in a short panel grows it temporarily and closing restores it.
  await page.keyboard.press("Meta+k");
  await expect.poll(last).toMatchObject({ temporary: true });
  expect((await last())?.contentHeight ?? 0).toBeGreaterThan(400);
  await page.keyboard.press("Escape");
  await expect.poll(last).toEqual({ contentHeight: start });

  // With auto-sizing off, content changes are not reported but temporary growth still is.
  await page.keyboard.press("Meta+Shift+Slash");
  const count = (await reports()).length;
  for (let i = 0; i < 3; i++) await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
  expect((await reports()).length).toBe(count);
  await page.keyboard.press("Meta+p");
  await expect.poll(last).toMatchObject({ temporary: true });
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await last())?.temporary).toBeUndefined();

  // The top 12 points stay free of controls for the native drag strip.
  await page.mouse.move(300, 120);
  const buttonTop = await page.getByTestId("new-note").evaluate((el) => el.getBoundingClientRect().top - el.closest(".app")!.getBoundingClientRect().top);
  expect(buttonTop).toBeGreaterThanOrEqual(12);
});

test("note text is 150% of the UI base and zoom scales it", async ({ page }) => {
  await openHarness(page, ["Title\n\nBody with `code`\n\n- item"]);
  const sizes = () =>
    page.evaluate(() => {
      const px = (selector: string) => parseFloat(getComputedStyle(document.querySelector(selector)!).fontSize);
      return { root: px("html"), body: px(".note-editor > p:nth-child(2)"), code: px(".note-editor code"), item: px(".note-editor [data-list-kind] p") };
    });
  const base = await sizes();
  // The old default was 14 px for both the UI and the note; the note is now 21 px at 100%.
  expect(base.root).toBe(14);
  expect(base.body).toBe(21);
  expect(base.item).toBe(21);
  expect(base.code).toBeCloseTo(21 * 0.88, 1);
  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => (await sizes()).body).toBeCloseTo(21 * 1.1, 1);
  const zoomed = await sizes();
  expect(zoomed.code / zoomed.body).toBeCloseTo(base.code / base.body, 3);
});

test("the first line is set apart as the title, live, without touching the stored note", async ({ page }) => {
  await openHarness(page, ["Hello\n\nbody text"]);
  const titleBlock = () => editor(page).locator(":scope > .note-title");
  const firstBlockIsTitle = () =>
    editor(page).evaluate((el) => {
      const titles = el.querySelectorAll(":scope > .note-title");
      return titles.length === 1 && el.firstElementChild === titles[0];
    });
  await expect(titleBlock()).toHaveText("Hello");
  expect(await firstBlockIsTitle()).toBe(true);
  const look = await page.evaluate(() => {
    const title = getComputedStyle(document.querySelector(".note-editor > .note-title")!);
    const body = getComputedStyle(document.querySelector(".note-editor > p:nth-child(2)")!);
    return {
      border: `${title.borderBottomWidth} ${title.borderBottomStyle}`,
      sameFont: title.fontFamily === body.fontFamily,
      gap: document.querySelector(".note-editor > p:nth-child(2)")!.getBoundingClientRect().top - document.querySelector(".note-editor > .note-title")!.getBoundingClientRect().bottom,
    };
  });
  expect(look).toMatchObject({ border: "1px solid", sameFont: true });
  expect(look.gap).toBeGreaterThan(6);

  // It follows the first line as it changes: a heading, then a list, then a new first line.
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.type("# ");
  await expect(editor(page).locator(":scope > h1.note-title")).toHaveText("Hello");
  await page.keyboard.press("Meta+Alt+Digit1");
  await page.keyboard.type("- ");
  await expect(titleBlock()).toHaveAttribute("data-list-kind", "bullet");
  await page.evaluate(() => (window as unknown as { __bnEditor: { commands: { focus(at: string): void } } }).__bnEditor.commands.focus("start"));
  await page.keyboard.type("New first line");
  await page.keyboard.press("Enter");
  await expect(titleBlock()).toHaveText("New first line");
  expect(await firstBlockIsTitle()).toBe(true);

  // The decoration never reaches the stored content.
  await expect.poll(async () => String((await lastSave(page)).markdown)).toMatch(/^- New first line\n- Hello/);
  expect(String((await lastSave(page)).rawContent)).not.toContain("note-title");

  // An empty note shows only the placeholder on the title line; the hairline appears once there is text.
  await openHarness(page);
  await expect(titleBlock()).toHaveAttribute("data-placeholder", "Start writing…");
  await expect(titleBlock()).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
  await page.keyboard.type("T");
  await expect(titleBlock()).not.toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
  await expect(titleBlock()).toHaveCSS("border-bottom-style", "solid");
});

test("Close, title, and icons share one line; icons are 20% larger", async ({ page }) => {
  await openHarness(page, ["Hello\n\nbody"]);
  await page.mouse.move(320, 200);
  const m = await page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const app = box(document.querySelector("[data-testid=app]")!);
    const close = box(document.querySelector("[data-testid=close]")!);
    const title = box(document.querySelector("[data-testid=title]")!);
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".note-editor > p")!);
    const text = range.getBoundingClientRect();
    const actions = [...document.querySelectorAll(".toolbar-actions .icon-button")].map(box);
    const icon = box(document.querySelector(".toolbar-actions .icon")!);
    return {
      closeLeft: close.left - app.left,
      textLeft: text.left - app.left,
      closeMid: close.top + close.height / 2,
      titleMid: title.top + title.height / 2,
      actionMids: actions.map((a) => a.top + a.height / 2),
      hit: actions.map((a) => [a.width, a.height]),
      icon: [icon.width, icon.height],
    };
  });
  expect(Math.abs(m.closeLeft - m.textLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(m.closeMid - m.titleMid)).toBeLessThanOrEqual(1);
  for (const mid of m.actionMids) expect(Math.abs(mid - m.titleMid)).toBeLessThanOrEqual(1);
  expect(m.icon[0]).toBeCloseTo(16.8, 1);
  for (const [w, h] of m.hit) {
    expect(w).toBeCloseTo(28.7, 1);
    expect(h).toBeCloseTo(28.7, 1);
  }
  // Controls stay clear of the helper's resize zones: 8 points along edges, 16 point squares at corners.
  const clearance = await page.evaluate(() => {
    const app = document.querySelector("[data-testid=app]")!.getBoundingClientRect();
    return [...document.querySelectorAll("[data-testid=toolbar] button, [data-testid=footer] button")].map((el) => {
      const r = el.getBoundingClientRect();
      const left = r.left - app.left;
      const top = r.top - app.top;
      const right = app.right - r.right;
      const bottom = app.bottom - r.bottom;
      const inCorner = (Math.min(left, right) < 16 && Math.min(top, bottom) < 16);
      return { name: el.getAttribute("aria-label") ?? el.textContent, edge: Math.min(left, top, right, bottom), inCorner };
    });
  });
  for (const c of clearance) {
    expect(c.edge, String(c.name)).toBeGreaterThanOrEqual(8);
    expect(c.inCorner, String(c.name)).toBe(false);
  }
  expect(m.closeLeft).toBeGreaterThanOrEqual(16);

  await page.keyboard.press("Alt+Meta+Comma");
  const formatIcon = await page.getByTestId("format-bar").locator(".format-button .icon").first().evaluate((el) => el.getBoundingClientRect().width);
  expect(formatIcon).toBeCloseTo(16.8, 1);
});

test("toolbar drag regions cover the empty toolbar and exclude every button", async ({ page }) => {
  await openHarness(page, ["Text"]);
  type Rect = { x: number; y: number; width: number; height: number };
  const lastRects = async () => ((await calls(page, "window.setDragRegions")).at(-1)?.params.rects ?? []) as Rect[];
  const verify = async () => {
    const rects = await lastRects();
    const layout = await page.evaluate(() => {
      const origin = document.querySelector("[data-testid=app]")!.getBoundingClientRect();
      const rel = (el: Element) => {
        const r = el.getBoundingClientRect();
        return { x: r.left - origin.left, y: r.top - origin.top, width: r.width, height: r.height };
      };
      return {
        toolbar: rel(document.querySelector("[data-testid=toolbar]")!),
        title: rel(document.querySelector("[data-testid=title]")!),
        buttons: [...document.querySelectorAll("[data-testid=toolbar] button")].map(rel),
      };
    });
    const inside = (r: Rect, x: number, y: number, pad = 0) => x >= r.x - pad && x <= r.x + r.width + pad && y >= r.y - pad && y <= r.y + r.height + pad;
    expect(layout.buttons).toHaveLength(4);
    // No region overlaps a button.
    for (const b of layout.buttons) {
      for (const r of rects) {
        const overlapX = Math.min(r.x + r.width, b.x + b.width) - Math.max(r.x, b.x);
        const overlapY = Math.min(r.y + r.height, b.y + b.height) - Math.max(r.y, b.y);
        expect(overlapX > 0.5 && overlapY > 0.5, `region ${JSON.stringify(r)} overlaps button ${JSON.stringify(b)}`).toBe(false);
      }
    }
    // Every other point of the toolbar drags, including the title and the top strip.
    const t = layout.toolbar;
    for (let x = t.x + 2; x < t.x + t.width; x += 9) {
      for (let y = t.y + 2; y < t.y + t.height; y += 5) {
        if (layout.buttons.some((b) => inside(b, x, y, 1.5))) continue;
        expect(rects.some((r) => inside(r, x, y)), `point ${x},${y} should drag`).toBe(true);
      }
    }
    expect(rects.some((r) => inside(r, layout.title.x + layout.title.width / 2, layout.title.y + layout.title.height / 2))).toBe(true);
    for (const r of rects) expect(inside(t, r.x, r.y, 1) && inside(t, r.x + r.width, r.y + r.height, 1)).toBe(true);
    return rects;
  };
  await expect.poll(async () => (await lastRects()).length).toBeGreaterThan(0);
  const first = await verify();

  // Zoom scales the toolbar, and the regions follow (in points, zoom applied).
  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => JSON.stringify(await lastRects())).not.toBe(JSON.stringify(first));
  await expect.poll(async () => Math.max(...(await lastRects()).map((r) => r.y + r.height))).toBeGreaterThan(Math.max(...first.map((r) => r.y + r.height)));
  await verify();

  // A narrower panel moves the right group, and the regions follow.
  await page.keyboard.press("Meta+0");
  const beforeResize = JSON.stringify(await lastRects());
  await page.setViewportSize({ width: 520, height: 720 });
  await expect.poll(async () => JSON.stringify(await lastRects())).not.toBe(beforeResize);
  await verify();

  // Hover chrome changes resend nothing new: the buttons are excluded whether shown or not.
  await page.mouse.move(260, 700);
  await page.mouse.move(260, 30);
  await page.waitForTimeout(250);
  await verify();
});

test("the accent is neutral: no cyan anywhere in the key elements", async ({ page }) => {
  await openHarness(page, ["Hello\n\n1. one\n\n- [x] done\n\n[link](https://raycast.com)"]);
  await page.mouse.move(320, 200);
  await page.keyboard.press("Alt+Meta+Comma");
  await editor(page).getByText("done").click();
  const colors = await page.evaluate(() => {
    const css = (selector: string, ...props: string[]) => {
      const el = document.querySelector(selector);
      if (!el) throw new Error(`missing ${selector}`);
      const style = getComputedStyle(el);
      return props.map((prop) => style.getPropertyValue(prop));
    };
    return {
      caret: css(".note-editor", "caret-color"),
      link: css(".note-editor a", "color", "text-decoration-line", "text-decoration-color"),
      text: css(".note-editor", "color"),
      ordered: css(".note-editor [data-list-kind=ordered]", "--accent"),
      orderedMarker: [getComputedStyle(document.querySelector(".note-editor [data-list-kind=ordered]")!, "::before").color],
      checkbox: css(".note-editor [data-list-kind=task] input", "border-top-color"),
      checked: [getComputedStyle(document.querySelector(".note-editor [data-list-kind=task] input")!, "::after").backgroundColor],
      activeFormat: css(".format-button.is-active", "color", "background-color"),
      toggle: css("[data-testid=format-toggle]", "color"),
      selection: css(".note-editor", "--selection", "--accent", "--accent-soft", "--focus-ring", "--surface-selected"),
    };
  });
  expect(colors.link[0]).toBe(colors.text[0]);
  expect(colors.link[1]).toBe("underline");
  const all = Object.values(colors).flat().join(" ");
  const channels = [...all.matchAll(/rgba?\(([^)]+)\)|#([0-9a-f]{6})/gi)].map((m) =>
    m[1] ? m[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3).map(Number) : [0, 2, 4].map((i) => parseInt(m[2]!.slice(i, i + 2), 16)),
  );
  expect(channels.length).toBeGreaterThan(10);
  for (const [r, g, b] of channels) expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!), `color ${r},${g},${b} in ${all}`).toBeLessThanOrEqual(12);

  // The link popover's focus ring is neutral too.
  await page.keyboard.press("Meta+l");
  const ring = await page.getByTestId("link-popover").getByRole("textbox").evaluate((el) => `${getComputedStyle(el).borderColor} ${getComputedStyle(el).boxShadow}`);
  for (const m of ring.matchAll(/rgba?\(([^)]+)\)/g)) {
    const [r, g, b] = m[1]!.split(/[ ,/]+/).map(Number);
    expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThanOrEqual(12);
  }
});

test("hover chrome and the Close control", async ({ page }) => {
  await openHarness(page, ["Text"]);
  await page.mouse.move(320, 700);
  await expect(page.getByTestId("close")).toHaveCSS("opacity", "0");
  await page.getByTestId("title").hover();
  await expect(page.getByTestId("close")).toHaveCSS("opacity", "1");
  await page.getByTestId("close").click();
  await expect.poll(async () => (await calls(page, "window.hide")).length).toBe(1);
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
  await editor(page).locator("a").click({ modifiers: ["Meta"] });
  await expect.poll(async () => (await calls(page, "app.openURL")).at(-1)?.params).toEqual({ url: "https://raycast.com" });
  await expect(popover).toHaveCount(0);
  await editor(page).locator("a").click();
  await expect(popover).toHaveAttribute("data-mode", "view");
  await popover.getByRole("button", { name: "Open Link" }).click();
  await expect.poll(async () => (await calls(page, "app.openURL")).length).toBe(2);
  await editor(page).locator("a").click();
  await expect(popover).toHaveAttribute("data-mode", "view");
  await popover.getByRole("button", { name: "Unlink" }).click();
  await expect(editor(page).locator("a")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Meta+l");
  await expect(page.getByTestId("notices")).toContainText("Select text to add a link");
});
