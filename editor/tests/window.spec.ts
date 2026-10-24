/** Window height and resize churn, zoom, note text size, the plain first line, motion, toolbar layout and drag regions, the counter, and the format bar. */
import { expect, test, type Page } from "@playwright/test";
import { calls, editor, lastSave, openHarness, pauseClock, settle } from "./harness";

test("resize reports follow content, zoom, and overlays", async ({ page }) => {
  await openHarness(page);
  const reports = async () =>
    (await calls(page, "window.resize")).map((c) => c.params as { contentHeight: number; temporary?: boolean });
  const last = async () => (await reports()).at(-1);
  const appHeight = () => page.getByTestId("app").evaluate((el) => el.getBoundingClientRect().height);

  // Auto-sizing is off by default: the panel opens roomy (560 points) and content is not reported.
  expect(await appHeight()).toBe(560);
  await settle(page);
  expect(await reports()).toEqual([]);

  // With auto-sizing on, a one-line note is about 143 points (one 120% line between the bars), so
  // the panel rests at the 197 point minimum, footer at the bottom.
  await page.keyboard.press("Meta+Shift+Slash");
  await expect.poll(async () => (await reports()).length).toBeGreaterThan(0);
  const start = (await last())?.contentHeight ?? 0;
  expect(start).toBeGreaterThanOrEqual(134);
  expect(start).toBeLessThanOrEqual(146);
  const resting = Math.max(197, start);
  await expect.poll(appHeight).toBe(resting);
  const footerGap = await page
    .getByTestId("footer")
    .evaluate((el) => el.closest(".app")!.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom);
  expect(footerGap).toBeLessThanOrEqual(1);

  // Each new line adds one line pitch (16.8 px at 1.65, plus the block gap).
  for (let i = 0; i < 5; i++) await page.keyboard.press("Enter");
  await expect.poll(async () => (await last())?.contentHeight ?? 0).toBeGreaterThan(start + 5 * 27);
  const tall = (await last())?.contentHeight ?? 0;
  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => (await last())?.contentHeight ?? 0).toBeGreaterThan(tall);
  for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
  await page.keyboard.press("Meta+0");
  await expect.poll(async () => (await last())?.contentHeight ?? 0).toBe(start);

  // ⌘K in a short panel never resizes it: the panel stays inside the note and its list scrolls.
  const reportsBeforePanel = (await reports()).length;
  // The harness applies a reported height a moment after the report; open ⌘K on the short note.
  await expect.poll(appHeight).toBe(resting);
  await page.keyboard.press("Meta+k");
  const panel = page.getByTestId("command-panel");
  await expect(panel).toBeVisible();
  await settle(page);
  const bottomGap = await panel.evaluate(
    (el) => el.closest(".app")!.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom,
  );
  expect(bottomGap).toBeGreaterThanOrEqual(9.5);
  expect(await appHeight()).toBe(resting);
  await page.keyboard.press("Escape");
  await settle(page);
  expect((await reports()).slice(reportsBeforePanel)).toEqual([]);
  expect(await appHeight()).toBe(resting);

  // With auto-sizing off, content changes are not reported, and browse stays inside the same way.
  await page.keyboard.press("Meta+Shift+Slash");
  const count = (await reports()).length;
  for (let i = 0; i < 3; i++) await page.keyboard.press("Enter");
  await settle(page);
  expect((await reports()).length).toBe(count);
  await page.keyboard.press("Meta+p");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await settle(page);
  expect((await reports()).length).toBe(count);

  // The top 12 points stay free of controls for the native drag strip.
  await page.mouse.move(300, 120);
  const buttonTop = await page
    .getByTestId("new-note")
    .evaluate((el) => el.getBoundingClientRect().top - el.closest(".app")!.getBoundingClientRect().top);
  expect(buttonTop).toBeGreaterThanOrEqual(12);
});

test("the minimum size is the bars plus one line at the current zoom, never below 405 x 197", async ({ page }) => {
  await openHarness(page, ["One line"]);
  const minimum = async () =>
    (await calls(page, "window.setMinimumSize")).at(-1)?.params as { width: number; height: number };
  const box = () =>
    page.getByTestId("app").evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
  await expect.poll(minimum).toBeTruthy();

  // At 100% the bars plus one line are what a one-line note reports as its content height.
  await page.keyboard.press("Meta+Shift+Slash");
  await expect.poll(async () => (await calls(page, "window.resize")).length).toBeGreaterThan(0);
  const oneLine = ((await calls(page, "window.resize")).at(-1)?.params.contentHeight as number) ?? 0;
  const atDefault = await minimum();
  expect(Math.abs(atDefault.height - oneLine)).toBeLessThanOrEqual(1);
  expect(atDefault.width).toBeLessThanOrEqual(405);
  await expect.poll(box).toEqual({ width: 640, height: 197 });

  // At 200% the bars and the line double, past the floor: the panel grows to the new minimum.
  await page.keyboard.press("Meta+Equal");
  for (let i = 0; i < 19; i++) await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => (await minimum()).height).toBeGreaterThanOrEqual(2 * oneLine - 8);
  const atDouble = await minimum();
  expect(atDouble.height).toBeLessThanOrEqual(2 * oneLine + 2);
  expect(atDouble.width).toBeGreaterThan(600);
  await expect.poll(async () => (await box()).height).toBe(atDouble.height);
  await expect.poll(async () => (await box()).width).toBe(atDouble.width);

  // Every bar fits: the toolbar controls, some of the title, and the format bar all stay inside.
  await page.keyboard.press("Alt+Meta+Comma");
  await expect(page.getByTestId("format-bar")).toBeVisible();
  await expect.poll(async () => (await minimum()).width).toBeGreaterThan(atDouble.width);
  await expect.poll(async () => (await box()).width).toBe((await minimum()).width);
  const fits = await page.getByTestId("app").evaluate((app) => {
    const edge = app.getBoundingClientRect();
    const inside = (el: Element | null) => {
      const r = el!.getBoundingClientRect();
      return r.left >= edge.left - 0.5 && r.right <= edge.right + 0.5;
    };
    const title = app.querySelector<HTMLElement>("[data-testid=title]")!;
    const formatBar = app.querySelector("[data-testid=format-bar]")!.getBoundingClientRect();
    const toggle = app.querySelector("[data-testid=format-toggle]")!.getBoundingClientRect();
    return {
      actions: inside(app.querySelector(".toolbar-actions")),
      formatBar: inside(app.querySelector("[data-testid=format-bar]")),
      clearOfToggle: formatBar.right <= toggle.left + 0.5,
      // A short title shows in full; the room kept for it is 6rem.
      titleShown: title.scrollWidth <= title.clientWidth && title.clientWidth > 0,
    };
  });
  expect(fits).toEqual({ actions: true, formatBar: true, clearOfToggle: true, titleShown: true });
});

test("note text is 120% of the UI base and zoom scales it", async ({ page }) => {
  await openHarness(page, ["Title\n\nBody with `code`\n\n- item"]);
  const sizes = () =>
    page.evaluate(() => {
      const px = (selector: string) => parseFloat(getComputedStyle(document.querySelector(selector)!).fontSize);
      return {
        root: px("html"),
        body: px(".note-editor > p:nth-child(2)"),
        code: px(".note-editor code"),
        item: px(".note-editor [data-list-kind] p"),
      };
    });
  const base = await sizes();
  // The UI base is 14 px; the note is 120% of it, 16.8 px at 100%, with a 1.65 line pitch.
  expect(base.root).toBe(14);
  expect(base.body).toBeCloseTo(16.8, 2);
  expect(base.item).toBeCloseTo(16.8, 2);
  expect(base.code).toBeCloseTo(16.8 * 0.88, 1);
  const pitch = await page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector(".note-editor > p:nth-child(2)")!).lineHeight),
  );
  expect(pitch).toBeCloseTo(16.8 * 1.65, 1);
  // The task checkbox and the list gutter follow the note text.
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[] task");
  const box = await editor(page)
    .locator("[data-list-kind=task] input")
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(box).toBeCloseTo(16.8 * 0.88, 0);
  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => (await sizes()).body).toBeCloseTo(16.8 * 1.1, 1);
  const zoomed = await sizes();
  expect(zoomed.code / zoomed.body).toBeCloseTo(base.code / base.body, 3);
});

test("blocks keep one balanced gap while list items stay tight", async ({ page }) => {
  await openHarness(page, [
    "Spacing\n\nIntro paragraph.\n\n- one\n- two\n  - nested\n\nBetween lists.\n\n1. first\n\nThen tasks:\n\n- [ ] task\n- [x] done\n\nNext paragraph.\n\n## Heading\n\nUnder the heading.\n\n```\ncode\n```\n\nAfter code.",
  ]);
  const layout = await page.evaluate(() => {
    const children = Array.from(document.querySelectorAll<HTMLElement>(".note-editor > *"));
    const label = (el: HTMLElement) => ((el.querySelector("pre") ?? el).textContent ?? "").trim().slice(0, 12);
    const gaps = children.slice(1).map((el, i) => ({
      from: label(children[i]!),
      to: label(el),
      gap: Math.round((el.getBoundingClientRect().top - children[i]!.getBoundingClientRect().bottom) * 100) / 100,
    }));
    const nested = document.querySelector<HTMLElement>(".list-content > .prosemirror-flat-list")!;
    const parent = nested.previousElementSibling as HTMLElement;
    return { gaps, nested: nested.getBoundingClientRect().top - parent.getBoundingClientRect().bottom };
  });
  const gap = (from: string, to: string) =>
    layout.gaps.find((g) => g.from.startsWith(from) && g.to.startsWith(to))?.gap;
  // 120% note text is 16.8 px: blocks are 0.6em apart (10.08 px), list items 0.2em (3.36 px), headings get 1.15em above.
  const block = 16.8 * 0.6;
  const item = 16.8 * 0.2;
  for (const [from, to] of [
    ["Intro", "one"],
    ["two", "Between"],
    ["Between", "first"],
    ["first", "Then"],
    ["Then", "task"],
    ["done", "Next"],
    ["Under", "code"],
    ["code", "After"],
  ]) {
    expect(gap(from!, to!), `${from} to ${to}`).toBeCloseTo(block, 0);
  }
  expect(gap("one", "two")).toBeCloseTo(item, 0);
  expect(gap("task", "done")).toBeCloseTo(item, 0);
  expect(layout.nested).toBeCloseTo(item, 0);
  expect(gap("Next", "Heading")).toBeCloseTo(16.8 * 1.15, 0);

  // The rhythm scales with zoom.
  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expect
    .poll(() =>
      page.evaluate(() =>
        parseFloat(getComputedStyle(document.querySelector(".note-editor > .prosemirror-flat-list")!).marginTop),
      ),
    )
    .toBeCloseTo(block * 1.1, 1);
});

test("the first line renders exactly like body text and still names the note", async ({ page }) => {
  await openHarness(page, ["Hello\n\nbody text\n\nmore"]);
  const look = (selector: string) =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel)!;
      const style = getComputedStyle(el);
      return {
        font: `${style.fontFamily} ${style.fontSize} ${style.fontWeight} ${style.lineHeight}`,
        box: `${style.paddingTop} ${style.paddingBottom} ${style.borderBottomWidth} ${style.marginBottom}`,
        className: el.className,
      };
    }, selector);
  const first = await look(".note-editor > p:nth-child(1)");
  const second = await look(".note-editor > p:nth-child(2)");
  expect(first).toEqual(second);
  expect(first.box).toBe("0px 0px 0px 0px");
  await expect(editor(page).locator(".note-title, .is-blank-note")).toHaveCount(0);
  // The same gap follows the first line as any other block.
  const gaps = await page.evaluate(() => {
    const [a, b, c] = [...document.querySelectorAll<HTMLElement>(".note-editor > p")].map((el) =>
      el.getBoundingClientRect(),
    );
    return [b!.top - a!.bottom, c!.top - b!.bottom];
  });
  expect(gaps[0]).toBeCloseTo(gaps[1]!, 1);

  // The title is still derived from the first line for the toolbar and storage.
  await expect(page.getByTestId("title")).toHaveText("Hello");
  await page.keyboard.press("Meta+ArrowUp");
  await page.keyboard.type("Say ");
  await expect(page.getByTestId("title")).toHaveText("Say Hello");
  await expect.poll(async () => String((await lastSave(page)).title)).toBe("Say Hello");

  // An empty note shows the placeholder in plain body style and a quiet "Untitled".
  await openHarness(page);
  await expect(editor(page).locator(":scope > p")).toHaveAttribute("data-placeholder", "Start writing…");
  await expect(page.getByTestId("title")).toHaveText("Untitled");
  await expect(page.getByTestId("title")).toHaveClass(/is-untitled/);
  await page.keyboard.type("T");
  await expect(page.getByTestId("title")).not.toHaveClass(/is-untitled/);
});

test("decorations, chrome, and panels never churn window.resize reports", async ({ page }) => {
  await openHarness(page, ["First line\n\nSecond line\n\nThird line"]);
  const count = async () => (await calls(page, "window.resize")).length;
  await page.keyboard.press("Meta+Shift+Slash");
  await expect.poll(count).toBeGreaterThan(0);
  await settle(page);

  // Typing on the first line reports no more than typing the same text on another line (none: no line wraps).
  const typeOn = async (line: number) => {
    await page.evaluate((index) => {
      const editorApi = (
        window as unknown as {
          __bnEditor: {
            state: { doc: { child(i: number): { nodeSize: number } } };
            commands: { setTextSelection(pos: number): void };
          };
        }
      ).__bnEditor;
      let pos = 1;
      for (let i = 0; i < index; i++) pos += editorApi.state.doc.child(i).nodeSize;
      editorApi.commands.setTextSelection(pos + 2);
    }, line);
    const before = await count();
    await page.keyboard.type(" more words");
    for (let i = 0; i < 11; i++) await page.keyboard.press("Backspace");
    await settle(page);
    return (await count()) - before;
  };
  const onFirst = await typeOn(0);
  const onSecond = await typeOn(1);
  expect(onFirst).toBeLessThanOrEqual(onSecond);
  expect(onFirst).toBe(0);

  // Selecting everything (the list gutter decoration) and the hover chrome send nothing.
  const quiet = await count();
  await page.keyboard.press("Meta+a");
  await page.mouse.move(320, 700);
  await page.mouse.move(320, 60);
  await page.mouse.move(320, 700);
  await settle(page);
  expect(await count()).toBe(quiet);

  // Toggling the format bar keeps the footer height.
  const footer = () => page.getByTestId("footer").evaluate((el) => el.getBoundingClientRect().height);
  const footerBefore = await footer();
  await page.keyboard.press("Alt+Meta+Comma");
  await expect(page.getByTestId("format-bar")).toBeVisible();
  expect(await footer()).toBe(footerBefore);
  await page.keyboard.press("Alt+Meta+Comma");
  await settle(page);
  expect(await count()).toBe(quiet);

  // In a panel already tall enough (the roomy first-open size), opening and closing panels never resizes.
  await openHarness(page, ["First line\n\nSecond line"]);
  await settle(page);
  const roomy = await count();
  for (const keys of ["Meta+k", "Meta+p", "Meta+Comma"]) {
    await page.keyboard.press(keys);
    await expect(page.getByTestId("command-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-panel")).toHaveCount(0);
  }
  await settle(page);
  expect(await count()).toBe(roomy);
});

test("motion: short ease-out transitions, a fading panel exit, and none with reduced motion", async ({ page }) => {
  // A fake clock owns every timer, so the notice timing is exact. CSS animations still run in real
  // time, which tells an exit that ends on its animation event from one ended by a fallback timer.
  await page.clock.install();
  await openHarness(page, ["Motion"]);
  const timing = () =>
    page.evaluate(() => {
      const css = (sel: string) => getComputedStyle(document.querySelector(sel)!);
      return {
        chrome: `${css(".toolbar-actions").transitionDuration} ${css(".toolbar-actions").transitionTimingFunction}`,
        panel: document.querySelector("[data-testid=command-panel]")
          ? `${css("[data-testid=command-panel]").animationName} ${css("[data-testid=command-panel]").animationDuration}`
          : "",
      };
    });
  await page.keyboard.press("Meta+k");
  const normal = await timing();
  expect(normal.chrome).toMatch(/^0\.15s cubic-bezier/);
  expect(normal.panel).toBe("panel-in 0.18s");
  await pauseClock(page);

  // Closing leaves an inert copy that fades out, then disappears; the live panel is gone at once.
  // The paused clock holds the fallback timer, so the copy leaves on its own animation end event.
  // The copy can finish its real animation before a later query runs on a slow machine, so its
  // attributes are recorded the moment it is inserted.
  await watchGhost(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
  const ghost = page.locator(".panel-ghost");
  expect(await ghostSnapshot(page)).toEqual({ ariaHidden: "true", testIds: 0, duration: "0.12s" });
  await expect(ghost).toHaveCount(0);
  await expect(editor(page)).toBeFocused();

  // The animation follows the --motion-fast token, and so does the fallback timer when no animation
  // end event comes: the token plus 100 ms.
  await page.evaluate(() => document.documentElement.style.setProperty("--motion-fast", "450ms"));
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("command-panel")).toBeVisible();
  await watchGhost(page);
  await page.keyboard.press("Escape");
  expect((await ghostSnapshot(page)).duration).toBe("0.45s");
  await expect(ghost).toHaveCount(0);
  await page.addStyleTag({ content: ".panel-ghost, .panel-ghost * { animation: none !important; }" });
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("command-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ghost).toHaveCount(1);
  await page.clock.runFor(540);
  await expect(ghost).toHaveCount(1);
  await page.clock.runFor(20);
  await expect(ghost).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--motion-fast");
    document.querySelectorAll("style").forEach((style) => {
      if (style.textContent?.includes(".panel-ghost, .panel-ghost *")) style.remove();
    });
  });

  // A notice stays for NOTICE_MS (2 s), is marked as leaving, and is removed when its fade
  // (--motion-slow) ends: the paused clock holds the fallback timer, so the transition end does it.
  await page.keyboard.press("Meta+Shift+d");
  await page.clock.runFor(10);
  const notice = page.locator(".notice");
  await expect(notice).toHaveText("Copied deeplink");
  expect(await notice.evaluate((el) => getComputedStyle(el).animationDelay)).toBe("0s");
  expect(await notice.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0.18s, 0.18s");
  await page.clock.runFor(1980);
  await expect(notice).not.toHaveAttribute("data-leaving");
  // The fade runs on real time and can remove the notice before a poll sees it leaving, so record
  // the mark as it lands.
  await notice.evaluate((element) => {
    const host = window as unknown as { __noticeLeft?: boolean };
    host.__noticeLeft = false;
    new MutationObserver(() => {
      if (element.getAttribute("data-leaving") === "true") host.__noticeLeft = true;
    }).observe(element, { attributes: true });
  });
  await page.clock.runFor(20);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __noticeLeft?: boolean }).__noticeLeft))
    .toBe(true);
  await expect(notice).toHaveCount(0);

  // Checking a task plays its check animation once; the next edit clears it, and a loaded note has none.
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("[] task");
  await expect(editor(page).locator(".just-checked")).toHaveCount(0);
  await editor(page).locator("[data-list-kind=task] input").click();
  await expect(editor(page).locator(".just-checked[data-list-checked]")).toHaveCount(1);
  expect(
    await editor(page)
      .locator(".just-checked input")
      .evaluate((el) => getComputedStyle(el, "::after").animationName),
  ).toBe("check-in");
  await page.keyboard.type("!");
  await expect(editor(page).locator(".just-checked")).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Meta+k");
  const reduced = await timing();
  expect(reduced.chrome).toMatch(/^0s /);
  expect(reduced.panel).toBe("panel-in 0s");
  // With reduced motion no copy is made at all: the copy would render in the same commit that
  // removes the panel, so there is nothing to wait for.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
  await expect(ghost).toHaveCount(0);

  // A leaving notice goes at once: removed at the same instant it is marked as leaving.
  await page.keyboard.press("Meta+Shift+d");
  await page.clock.runFor(10);
  await expect(notice).toHaveText("Copied deeplink");
  await page.clock.runFor(1980);
  await expect(notice).toHaveCount(1);
  await page.clock.runFor(20);
  await expect(notice).toHaveCount(0);
});

test("opening a note never flashes: hidden until ready, caret and scroll restored in the first frame", async ({
  page,
}) => {
  const long = ["Long", ...Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`), "Last line"].join("\n\n");
  // Sample every animation frame from the very first one.
  await page.addInitScript(() => {
    const frames: { ready: string; visible: boolean; text: string; top: number }[] = [];
    (window as unknown as { __frames: typeof frames }).__frames = frames;
    const loop = () => {
      const app = document.querySelector("[data-testid=app]");
      const inner = document.querySelector(".content-inner");
      const content = document.querySelector(".content");
      if (app && inner && content) {
        frames.push({
          ready: app.getAttribute("data-ready") ?? "",
          visible: getComputedStyle(inner).visibility === "visible",
          text: (document.querySelector(".note-editor")?.textContent ?? "").slice(0, 12),
          top: content.scrollTop,
        });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const seed = encodeURIComponent(JSON.stringify(["Short note", long]));
  await page.goto(`/?seed=${seed}`);
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  const frames = () =>
    page.evaluate(
      () =>
        (window as unknown as { __frames: { ready: string; visible: boolean; text: string; top: number }[] }).__frames,
    );
  // Before the note is in place nothing of the editor is visible (no placeholder flash).
  const boot = await frames();
  expect(boot.length).toBeGreaterThan(0);
  for (const frame of boot) if (frame.ready !== "true") expect(frame.visible).toBe(false);
  for (const frame of boot) if (frame.visible) expect(frame.text).toBe("LongLine 1Li");

  // Switching to a note with its caret at the end shows it already scrolled to the caret.
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("Short");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("title")).toHaveText("Short note");
  await page.evaluate(() => {
    const mock = (
      window as unknown as {
        __overnoteMock: { store: { notes: Map<string, { title: string; caretPosition: number }> } };
      }
    ).__overnoteMock;
    for (const note of mock.store.notes.values()) if (note.title === "Long") note.caretPosition = 100000;
  });
  await page.evaluate(() => ((window as unknown as { __frames: unknown[] }).__frames.length = 0));
  await page.keyboard.press("Meta+p");
  await page.keyboard.type("Long");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("title")).toHaveText("Long");
  // Sample a good run of frames after the switch (any jump would show up in them).
  const sampled = async () => (await frames()).filter((frame) => frame.text.startsWith("Long")).length;
  await expect.poll(sampled, { timeout: 10_000 }).toBeGreaterThanOrEqual(15);
  const switched = (await frames()).filter((frame) => frame.text.startsWith("Long"));
  expect(switched.length).toBeGreaterThan(0);
  const finalTop = switched.at(-1)!.top;
  expect(finalTop).toBeGreaterThan(300);
  for (const frame of switched) expect(frame.top).toBe(finalTop);
});

test("select all paints the list gutter like the rest of the selection", async ({ page }) => {
  await openHarness(page, ["Lists\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [ ] task\n\nAfter"]);
  await page.mouse.move(320, 710);
  // The browser draws the text selection only in the focused editor; the editor takes focus
  // right after it loads the note, so wait for that before selecting.
  await expect(editor(page)).toBeFocused();
  await page.keyboard.press("Meta+a");
  await expect(editor(page).locator(".prosemirror-flat-list.in-selection")).toHaveCount(6);
  // Sample the gutter beside each bullet and number and the content column on the same row.
  const points = await page.evaluate(() => {
    const rows = [
      ...document.querySelectorAll<HTMLElement>(
        ".note-editor .prosemirror-flat-list:is([data-list-kind=bullet], [data-list-kind=ordered]) > .list-content > p",
      ),
    ];
    return rows.map((p) => {
      const list = p.closest(".prosemirror-flat-list")!.getBoundingClientRect();
      const r = p.getBoundingClientRect();
      const y = Math.round(r.top + r.height * 0.85);
      return { gutter: { x: Math.round(list.left + 2), y }, content: { x: Math.round(r.right - 20), y } };
    });
  });
  expect(points.length).toBe(5);
  // The selection fades in; compare colors only once every transition has finished.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  const shot = (await page.screenshot()).toString("base64");
  const pixels = await page.evaluate(
    async ({ b64, pts }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const scale = img.width / window.innerWidth;
      const at = (p: { x: number; y: number }) => [
        ...ctx.getImageData(Math.round(p.x * scale), Math.round(p.y * scale), 1, 1).data.slice(0, 3),
      ];
      return pts.map((p) => ({ gutter: at(p.gutter), content: at(p.content) }));
    },
    { b64: shot, pts: points },
  );
  for (const { gutter, content } of pixels) {
    for (let i = 0; i < 3; i++)
      expect(Math.abs(gutter[i]! - content[i]!), `gutter ${gutter} vs content ${content}`).toBeLessThanOrEqual(3);
  }
  // Collapsing the selection removes the decoration.
  await page.keyboard.press("ArrowRight");
  await expect(editor(page).locator(".in-selection")).toHaveCount(0);
});

test("Close, title, and icons share one line; icons are about a third larger", async ({ page }) => {
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
  expect(m.icon[0]).toBeCloseTo(18.48, 1);
  for (const [w, h] of m.hit) {
    expect(w).toBeCloseTo(31.5, 1);
    expect(h).toBeCloseTo(31.5, 1);
  }
  // Controls stay clear of the helper's resize zones: 10 points along edges, 24 point squares at corners.
  const clearance = await page.evaluate(() => {
    const app = document.querySelector("[data-testid=app]")!.getBoundingClientRect();
    return [...document.querySelectorAll("[data-testid=toolbar] button, [data-testid=footer] button")].map((el) => {
      const r = el.getBoundingClientRect();
      const left = r.left - app.left;
      const top = r.top - app.top;
      const right = app.right - r.right;
      const bottom = app.bottom - r.bottom;
      const inCorner = Math.min(left, right) < 24 && Math.min(top, bottom) < 24;
      return {
        name: el.getAttribute("aria-label") ?? el.textContent,
        edge: Math.min(left, top, right, bottom),
        inCorner,
      };
    });
  });
  for (const c of clearance) {
    expect(c.edge, String(c.name)).toBeGreaterThanOrEqual(10);
    expect(c.inCorner, String(c.name)).toBe(false);
  }
  expect(m.closeLeft).toBeGreaterThanOrEqual(24);

  await page.keyboard.press("Alt+Meta+Comma");
  const formatIcon = await page
    .getByTestId("format-bar")
    .locator(".format-button .icon")
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(formatIcon).toBeCloseTo(18.48, 1);
});

test("panels drop from the toolbar button that opened them, right aligned under the buttons", async ({ page }) => {
  await openHarness(page, ["Anchored"]);
  const geometry = async () =>
    page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
      const panel = document.querySelector<HTMLElement>("[data-testid=command-panel]")!;
      const p = panel.getBoundingClientRect();
      const origin = parseFloat(getComputedStyle(panel).transformOrigin.split(" ")[0] ?? "0");
      return {
        originX: p.left + origin,
        top: p.top,
        right: p.right,
        actions: box("[data-anchor=actions]"),
        browse: box("[data-anchor=browse]"),
        plus: box("[data-testid=new-note]"),
      };
    });
  const settled = () => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
  await page.mouse.move(320, 200);
  await page.locator("[data-anchor=actions]").click();
  await settled();
  let g = await geometry();
  expect(Math.abs(g.originX - (g.actions.left + g.actions.width / 2))).toBeLessThanOrEqual(1);
  expect(g.top).toBeGreaterThan(g.actions.bottom);
  expect(Math.abs(g.right - g.plus.right)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await page.locator("[data-anchor=browse]").click();
  await expect(page.getByTestId("command-panel")).toHaveAttribute("data-view", "browse");
  await settled();
  g = await geometry();
  expect(Math.abs(g.originX - (g.browse.left + g.browse.width / 2))).toBeLessThanOrEqual(1);
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
    const inside = (r: Rect, x: number, y: number, pad = 0) =>
      x >= r.x - pad && x <= r.x + r.width + pad && y >= r.y - pad && y <= r.y + r.height + pad;
    expect(layout.buttons).toHaveLength(4);
    // No region overlaps a button.
    for (const b of layout.buttons) {
      for (const r of rects) {
        const overlapX = Math.min(r.x + r.width, b.x + b.width) - Math.max(r.x, b.x);
        const overlapY = Math.min(r.y + r.height, b.y + b.height) - Math.max(r.y, b.y);
        expect(
          overlapX > 0.5 && overlapY > 0.5,
          `region ${JSON.stringify(r)} overlaps button ${JSON.stringify(b)}`,
        ).toBe(false);
      }
    }
    // Every other point of the toolbar drags, including the title and the top strip.
    const t = layout.toolbar;
    for (let x = t.x + 2; x < t.x + t.width; x += 9) {
      for (let y = t.y + 2; y < t.y + t.height; y += 5) {
        if (layout.buttons.some((b) => inside(b, x, y, 1.5))) continue;
        expect(
          rects.some((r) => inside(r, x, y)),
          `point ${x},${y} should drag`,
        ).toBe(true);
      }
    }
    expect(
      rects.some((r) => inside(r, layout.title.x + layout.title.width / 2, layout.title.y + layout.title.height / 2)),
    ).toBe(true);
    for (const r of rects) expect(inside(t, r.x, r.y, 1) && inside(t, r.x + r.width, r.y + r.height, 1)).toBe(true);
    return rects;
  };
  await expect.poll(async () => (await lastRects()).length).toBeGreaterThan(0);
  const first = await verify();

  // Zoom scales the toolbar, and the regions follow (in points, zoom applied).
  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => JSON.stringify(await lastRects())).not.toBe(JSON.stringify(first));
  await expect
    .poll(async () => Math.max(...(await lastRects()).map((r) => r.y + r.height)))
    .toBeGreaterThan(Math.max(...first.map((r) => r.y + r.height)));
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
  await settle(page);
  await verify();
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
    "Heading 1⌥⌘1",
    "Heading 2⌥⌘2",
    "Heading 3⌥⌘3",
    "Bold⌘B",
    "Italic⌘I",
    "Strikethrough⇧⌘S",
    "Underline⌘U",
    "Code⌘E",
    "Code Block⌥⌘C",
    "Blockquote⇧⌘B",
    "Ordered List⇧⌘7",
    "Bullet List⇧⌘8",
    "Task List⇧⌘9",
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
  await editor(page)
    .locator("a")
    .click({ modifiers: ["Meta"] });
  await expect
    .poll(async () => (await calls(page, "app.openURL")).at(-1)?.params)
    .toEqual({ url: "https://raycast.com" });
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

type GhostSnapshot = { ariaHidden: string | null; testIds: number; duration: string };

/** Records the exit ghost's attributes synchronously when it is inserted into the document. */
async function watchGhost(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ghost?: unknown; __ghostObserver?: MutationObserver };
    w.__ghostObserver?.disconnect();
    w.__ghost = null;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          const ghost = node.matches(".panel-ghost") ? node : node.querySelector<HTMLElement>(".panel-ghost");
          if (!ghost) continue;
          const panel = ghost.querySelector<HTMLElement>(".panel");
          w.__ghost = {
            ariaHidden: ghost.getAttribute("aria-hidden"),
            testIds: ghost.querySelectorAll("[data-testid]").length,
            duration: panel ? getComputedStyle(panel).animationDuration : "",
          };
          observer.disconnect();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    w.__ghostObserver = observer;
  });
}

async function ghostSnapshot(page: Page): Promise<GhostSnapshot> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __ghost?: unknown }).__ghost ?? null))
    .not.toBeNull();
  return page.evaluate(() => (window as unknown as { __ghost: GhostSnapshot }).__ghost);
}

test("with legacy scrollbars every scroller draws a thin one of its own", async ({ page }) => {
  await openHarness(page, [Array.from({ length: 60 }, (_, i) => `Line ${i + 1}`).join("\n\n")]);
  // The system's own choice, measured on a scroller the stylesheet leaves alone.
  const systemLegacy = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "scrollbar-probe";
    probe.style.cssText = "position:absolute;width:100px;height:100px;overflow:scroll";
    document.body.append(probe);
    const legacy = probe.offsetWidth - probe.clientWidth > 0;
    probe.remove();
    return legacy;
  });
  expect(await page.evaluate(() => document.documentElement.dataset.scrollbars ?? null)).toBe(
    systemLegacy ? "legacy" : null,
  );
  // Forced on, as with a mouse and no trackpad: a scroller gets a 0.7rem scrollbar, the probe keeps the system's.
  const widths = await page.evaluate(() => {
    document.documentElement.dataset.scrollbars = "legacy";
    const make = (className: string) => {
      const element = document.createElement("div");
      element.className = className;
      element.style.cssText = "position:absolute;width:100px;height:100px;overflow:scroll";
      document.body.append(element);
      const width = element.offsetWidth - element.clientWidth;
      element.remove();
      return width;
    };
    return { scroller: make("panel-list"), probe: make("scrollbar-probe") };
  });
  expect(widths.scroller).toBeGreaterThanOrEqual(9);
  expect(widths.scroller).toBeLessThanOrEqual(10);
  expect(widths.probe).toBe(systemLegacy ? 15 : 0);
});
