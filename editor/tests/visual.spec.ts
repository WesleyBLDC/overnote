/** Visual baselines: the smallest useful matrix, light and dark at the default 100 percent zoom. */
import { expect, test, type Page } from "@playwright/test";
import { calls, editor, emit, openHarness, settle } from "./harness";

const NORMAL = "# Morning notes\n\nA short paragraph for the visual baseline.\n\n- First point\n- Second point";
const CODE_AND_TASKS =
  "# Build checks\n\n- [ ] Run the editor tests\n- [x] Review the diff\n\n```js\n// Check the token contrast\nconst answer = 42;\n```";
const ACCENT =
  "# Accent check\n\nRead [the guide](https://example.com) before the first step.\n\n1. First step\n2. Second step\n\n- [ ] Open item\n- [x] Done item\n\nSelect this line for the tint.";
const LONG = [
  "# Long note",
  ...Array.from(
    { length: 24 },
    (_, i) => `Paragraph ${i + 1} with enough words to wrap onto a second line when the panel is zoomed in.`,
  ),
].join("\n\n");
const WIDE =
  "# Wide code\n\n```js\nconst total = firstValue + secondValue + thirdValue + fourthValue + fifthValue + sixthValue + seventhValue;\n```\n\nAfter the wide block.";

async function openVisual(page: Page, scheme: "light" | "dark", notes: string[] = []): Promise<void> {
  await page.emulateMedia({ colorScheme: scheme });
  await openHarness(page, notes);
  await page.mouse.move(12, 12);
}

async function shot(page: Page, name: string): Promise<void> {
  await settle(page);
  await expect(page.getByTestId("app")).toHaveScreenshot(name, { animations: "disabled", caret: "hide" });
}

async function setZoom(page: Page, zoom: number): Promise<void> {
  const current = await page.evaluate((value) => {
    const mock = (window as unknown as { __overnoteMock: { store: { settings: Record<string, unknown> } } })
      .__overnoteMock;
    mock.store.settings = { ...mock.store.settings, zoom: value };
    return mock.store.settings;
  }, zoom);
  await emit(page, "settings.changed", { ...current, zoom });
  await expect
    .poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)))
    .toBeCloseTo(14 * zoom, 1);
  await settle(page);
}

/** At any zoom, visible chrome controls meet the 28 point floor, do not overlap, and keep the footer in the app. */
async function assertZoomLayout(page: Page): Promise<void> {
  await expect(page.getByTestId("footer")).toBeVisible();
  const metrics = await page.evaluate(() => {
    const app = document.querySelector("[data-testid=app]")!.getBoundingClientRect();
    const footer = document.querySelector("[data-testid=footer]")!.getBoundingClientRect();
    const selector =
      "[data-testid=toolbar] button, [data-testid=footer] button, .find-bar button, .find-bar input, .panel button, .panel input, .panel .panel-row, .menu button, .dialog button";
    const elements = [...document.querySelectorAll<HTMLElement>(selector)].filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    });
    const rects = elements.map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        label: el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 24) ?? el.className,
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
    });
    const undersized = rects.filter((rect) => rect.width < 27.5 || rect.height < 27.5);
    const buttons = rects.filter((_, i) => elements[i]!.tagName === "BUTTON");
    // Buttons scrolled out of a horizontal scroll container are clipped, not overlapping what they pass under.
    const clipped = elements
      .map((el, i) => {
        if (el.tagName !== "BUTTON") return null;
        let rect = el.getBoundingClientRect();
        let node = el.parentElement;
        while (node) {
          const style = getComputedStyle(node);
          if (/(auto|hidden|clip|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
            const bounds = node.getBoundingClientRect();
            rect = new DOMRect(
              Math.max(rect.left, bounds.left),
              Math.max(rect.top, bounds.top),
              Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left),
              Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top),
            );
          }
          node = node.parentElement;
        }
        return rect.width > 0 && rect.height > 0
          ? { label: buttons.find((_, j) => elements[j] === el)?.label ?? "", rect, source: rects[i]! }
          : null;
      })
      .filter(Boolean) as { label: string; rect: DOMRect; source: (typeof rects)[number] }[];
    const overlaps: string[] = [];
    for (let i = 0; i < clipped.length; i++) {
      for (let j = i + 1; j < clipped.length; j++) {
        const a = clipped[i]!.rect;
        const b = clipped[j]!.rect;
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 1 && overlapY > 1) overlaps.push(`${clipped[i]!.label} overlaps ${clipped[j]!.label}`);
      }
    }
    return {
      undersized,
      overlaps,
      footerInside: footer.bottom <= app.bottom + 1 && footer.top >= app.top - 1,
      footerVisible: footer.height > 0 && footer.bottom > footer.top,
    };
  });
  expect(metrics.undersized, JSON.stringify(metrics.undersized)).toEqual([]);
  expect(metrics.overlaps, JSON.stringify(metrics.overlaps)).toEqual([]);
  expect(metrics.footerInside).toBe(true);
  expect(metrics.footerVisible).toBe(true);
}

/** Height reporting still follows content after a zoom change: a resize report lands and the mock applies it. */
async function assertHeightReporting(page: Page): Promise<void> {
  const before = (await calls(page, "window.resize")).length;
  await page.keyboard.press("Meta+Shift+Slash");
  await expect.poll(async () => (await calls(page, "window.resize")).length).toBeGreaterThan(before);
  const last = (await calls(page, "window.resize")).at(-1)?.params as { contentHeight: number } | undefined;
  expect(last?.contentHeight ?? 0).toBeGreaterThan(0);
  await page.keyboard.press("Meta+Shift+Slash");
}

for (const scheme of ["light", "dark"] as const) {
  test(`visual ${scheme} normal note`, async ({ page }) => {
    await openVisual(page, scheme, [NORMAL]);
    await shot(page, `${scheme}-normal.png`);
  });

  test(`visual ${scheme} empty note`, async ({ page }) => {
    await openVisual(page, scheme);
    await expect(editor(page).locator("p.is-empty")).toHaveAttribute("data-placeholder", "Start writing…");
    await expect(page.getByTestId("empty-hints")).toContainText("Type / to insert a block");
    await shot(page, `${scheme}-empty.png`);
  });

  test(`visual ${scheme} browse overlay`, async ({ page }) => {
    await openVisual(page, scheme, ["# Alpha\n\nFirst note body", "# Beta\n\nSecond note body", NORMAL]);
    await page.keyboard.press("Meta+p");
    await expect(page.getByTestId("command-panel")).toHaveAttribute("data-view", "browse");
    await expect(page.getByTestId("browse-row")).toHaveCount(3);
    await shot(page, `${scheme}-browse.png`);
  });

  test(`visual ${scheme} settings`, async ({ page }) => {
    await openVisual(page, scheme, [NORMAL]);
    await page.keyboard.press("Meta+Comma");
    await expect(page.getByTestId("command-panel")).toHaveAttribute("data-view", "settings");
    await expect(page.getByTestId("setting-escapeLosesFocus")).toBeVisible();
    await shot(page, `${scheme}-settings.png`);
  });

  test(`visual ${scheme} find bar`, async ({ page }) => {
    await openVisual(page, scheme, ["# Morning notes\n\nNotes to keep. More notes here."]);
    await page.keyboard.press("Meta+f");
    await page.getByTestId("find-input").fill("notes");
    await expect(page.getByTestId("find-count")).toHaveText("1 of 3");
    await shot(page, `${scheme}-find.png`);
  });

  test(`visual ${scheme} find no results`, async ({ page }) => {
    await openVisual(page, scheme, ["# Morning notes\n\nNotes to keep. More notes here."]);
    await page.keyboard.press("Meta+f");
    await page.getByTestId("find-input").fill("missing");
    await expect(page.getByTestId("find-count")).toHaveText("No results");
    await shot(page, `${scheme}-find-no-results.png`);
  });

  test(`visual ${scheme} code and tasks note`, async ({ page }) => {
    await openVisual(page, scheme, [CODE_AND_TASKS]);
    await expect(editor(page).locator(".hljs-comment")).toHaveText("// Check the token contrast");
    await shot(page, `${scheme}-code-tasks.png`);
  });

  test(`visual ${scheme} accent note`, async ({ page }) => {
    await openVisual(page, scheme, [ACCENT]);
    await expect(editor(page).locator("a")).toHaveText("the guide");
    const accentState = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      probe.style.color = "var(--accent)";
      const accent = getComputedStyle(probe).color;
      probe.style.color = "var(--accent-strong)";
      const strong = getComputedStyle(probe).color;
      probe.remove();
      const link = document.querySelector(".note-editor a");
      const ordered = document.querySelector('[data-list-kind="ordered"]');
      return {
        accent,
        strong,
        link: link ? getComputedStyle(link).color : null,
        linkUnderline: link ? getComputedStyle(link).textDecorationColor : null,
        ordered: ordered ? getComputedStyle(ordered, "::before").color : null,
        selection: getComputedStyle(document.documentElement).getPropertyValue("--selection").trim(),
      };
    });
    expect(accentState.link).toBe(accentState.strong);
    expect(accentState.linkUnderline).not.toBe(accentState.link);
    expect(accentState.ordered).toBe(accentState.accent);
    expect(accentState.selection).toContain(scheme === "light" ? "91, 75, 213" : "143, 128, 255");
    await editor(page).getByText("Select this line for the tint.").click({ clickCount: 3 });
    await shot(page, `${scheme}-accent.png`);
  });
}

const ZOOM_FIXTURES = [
  ["normal", NORMAL],
  ["long", LONG],
  ["wide", WIDE],
] as const;

for (const scheme of ["light", "dark"] as const) {
  for (const zoom of [0.75, 2] as const) {
    const zoomLabel = zoom === 0.75 ? "75" : "200";
    for (const [name, fixture] of ZOOM_FIXTURES) {
      test(`visual ${scheme} zoom ${zoomLabel} ${name} note`, async ({ page }) => {
        await openVisual(page, scheme, [fixture]);
        await setZoom(page, zoom);
        if (name === "wide") await expect(editor(page).locator(".code-block pre")).toBeVisible();
        await assertZoomLayout(page);
        await shot(page, `${scheme}-zoom${zoomLabel}-${name}.png`);
        await assertHeightReporting(page);
      });
    }
  }
}

test("visual zoom 200 overlays dock, cap, wrap, and scroll", async ({ page }) => {
  await openVisual(page, "dark", [
    "# A very long note title that would otherwise be cut off at high zoom levels\n\nBody",
    NORMAL,
  ]);
  await setZoom(page, 2);

  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("command-panel")).toHaveAttribute("data-view", "browse");
  await settle(page);
  const panel = await page.evaluate(() => {
    const panelEl = document.querySelector("[data-testid=command-panel]")!.getBoundingClientRect();
    const app = document.querySelector("[data-testid=app]")!.getBoundingClientRect();
    const subtitle = document.querySelector(".panel-row-subtitle")!.getBoundingClientRect();
    return { panelWidth: panelEl.width, appWidth: app.width, subtitleHeight: subtitle.height };
  });
  const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect(panel.panelWidth).toBeLessThanOrEqual(Math.min(24 * rem, panel.appWidth * 0.92) + 1);
  await assertZoomLayout(page);
  await shot(page, "dark-zoom200-browse.png");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
  await expect(editor(page)).toBeFocused();

  await page.keyboard.press("Meta+f");
  await settle(page);
  const find = await page.evaluate(() => {
    const bar = document.querySelector(".find-bar")!.getBoundingClientRect();
    const app = document.querySelector("[data-testid=app]")!.getBoundingClientRect();
    return { barLeft: bar.left - app.left, barRight: app.right - bar.right };
  });
  expect(Math.abs(find.barLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(find.barRight)).toBeLessThanOrEqual(1);
  await assertZoomLayout(page);
  await shot(page, "dark-zoom200-find.png");
  await page.keyboard.press("Escape");
  await expect(editor(page)).toBeFocused();

  await page.keyboard.press("Alt+Meta+Comma");
  await expect(page.getByTestId("format-bar")).toBeVisible();
  const format = await page.getByTestId("format-bar").evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    overflowX: getComputedStyle(el).overflowX,
    wraps: el.getBoundingClientRect().height,
    highZoom: document.documentElement.dataset.highZoom,
    zoomVar: getComputedStyle(document.documentElement).getPropertyValue("--zoom"),
  }));
  expect(format.overflowX, JSON.stringify(format)).toBe("auto");
  await assertZoomLayout(page);
  await shot(page, "dark-zoom200-format.png");
});

for (const scheme of ["light", "dark"] as const) {
  test(`visual ${scheme} focus ring and roving selection`, async ({ page }) => {
    await openVisual(page, scheme, [NORMAL, "# Second note\n\nAnother body"]);
    await setZoom(page, scheme === "dark" ? 2 : 1);
    await page.keyboard.press("Meta+p");
    await expect(page.getByTestId("command-panel")).toHaveAttribute("data-view", "browse");
    await settle(page);
    const panelState = await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>("[data-testid=browse-row]")];
      const selected = rows.find((row) => row.classList.contains("is-selected"))!;
      const style = getComputedStyle(selected);
      const title = selected.querySelector<HTMLElement>(".panel-row-title")!;
      return {
        tabbableRows: rows.filter((row) => row.tabIndex === 0).length,
        selectedTabbable: selected.tabIndex === 0,
        otherRowsMinusOne: rows.filter((row) => row !== selected).every((row) => row.tabIndex === -1),
        tabbableButtonsInPanel: [
          ...document.querySelectorAll<HTMLElement>("[data-testid=command-panel] button"),
        ].filter((button) => button.tabIndex === 0).length,
        background: style.backgroundColor,
        titleWeight: getComputedStyle(title).fontWeight,
        activeElement: document.activeElement?.className ?? "",
      };
    });
    expect(panelState.tabbableRows).toBe(1);
    expect(panelState.selectedTabbable).toBe(true);
    expect(panelState.otherRowsMinusOne).toBe(true);
    expect(panelState.tabbableButtonsInPanel).toBe(0);
    expect(panelState.titleWeight).toBe("500");
    expect(panelState.background).toContain(scheme === "light" ? "0.12" : "0.15");
    expect(panelState.activeElement).toContain("panel-search");

    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const selected = document.querySelector<HTMLElement>("[data-testid=browse-row].is-selected")!;
      return { focused: document.activeElement === selected, shadow: getComputedStyle(selected).boxShadow };
    });
    expect(ring.focused).toBe(true);
    expect(ring.shadow).not.toBe("none");
    expect(ring.shadow.split("rgb").length - 1).toBeGreaterThanOrEqual(2);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-panel")).toHaveCount(0);
    await expect(editor(page)).toBeFocused();

    await page.keyboard.type("/");
    const slash = page.getByTestId("slash-menu");
    await expect(slash).toBeVisible();
    const slashState = await slash.evaluate((el) => {
      const options = [...el.querySelectorAll<HTMLElement>('[role="option"]')];
      return {
        tabbable: options.filter((option) => option.tabIndex === 0).length,
        selectedTabbable: options.find((option) => option.classList.contains("is-selected"))?.tabIndex,
      };
    });
    expect(slashState).toEqual({ tabbable: 1, selectedTabbable: 0 });
    await page.keyboard.press("ArrowDown");
    const slashAfter = await slash.evaluate((el) => {
      const options = [...el.querySelectorAll<HTMLElement>('[role="option"]')];
      return (
        options.findIndex((option) => option.tabIndex === 0) ===
        options.findIndex((option) => option.classList.contains("is-selected"))
      );
    });
    expect(slashAfter).toBe(true);
    await page.keyboard.press("Escape");
    await expect(editor(page)).toBeFocused();
  });
}

test("visual zoom 200 reduced motion entrances land instantly", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await openHarness(page, [NORMAL]);
  await setZoom(page, 2);
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("command-panel")).toBeVisible();
  const duration = await page.getByTestId("command-panel").evaluate((el) => getComputedStyle(el).animationDuration);
  expect(duration).toBe("0s");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
  await expect(editor(page)).toBeFocused();
});
