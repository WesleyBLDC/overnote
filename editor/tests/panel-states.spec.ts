/** The command panel as one surface: loading and error states, roving focus, sections, and action icons. */
import { expect, test, type Page } from "@playwright/test";
import { openHarness, settle } from "./harness";

const NOTES = ["# Alpha\n\nFirst", "# Beta\n\nSecond"];

type Control = { latency: number; hang: Set<string>; failNext: Record<string, number> };

/** Changes the mock's misbehaviour for the calls that follow. */
function mock(page: Page, change: { latency?: number; hang?: string; fail?: string }) {
  return page.evaluate((c) => {
    const control = (window as unknown as { __overnoteMock: Control }).__overnoteMock;
    if (c.latency !== undefined) control.latency = c.latency;
    if (c.hang) control.hang.add(c.hang);
    if (c.fail) control.failNext[c.fail] = 500;
  }, change);
}

/** Opens the harness with the mock faults set from the URL, as a person would by hand. */
async function openWithFaults(page: Page, faults: string) {
  await page.goto(`/?seed=${encodeURIComponent(JSON.stringify(NOTES))}&${faults}`);
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.locator(".note-editor").focus();
}

/** Within the panel: how many elements Tab can reach, and how many of those are buttons inside rows. */
const tabbable = (page: Page, scope = "[data-testid=command-panel]") =>
  page.evaluate((selector) => {
    const root = document.querySelector(selector)!;
    const reachable = [...root.querySelectorAll<HTMLElement>("[tabindex], button, input")].filter(
      (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
    );
    const options = reachable.filter((el) => el.getAttribute("role") === "option" || el.matches(".menu-item"));
    return {
      options: options.length,
      selectedIsTabbable: options.every((el) => el.getAttribute("aria-selected") !== "false"),
      rowButtons: reachable.filter((el) => el.closest("[role=option]") && el.getAttribute("role") !== "option").length,
    };
  }, scope);

const ring = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    return { testId: el.dataset.testid ?? el.className, shadow: getComputedStyle(el).boxShadow };
  });

test("browse shows inert skeleton rows with note row geometry until the first page arrives", async ({ page }) => {
  await openHarness(page, NOTES);
  await mock(page, { latency: 600 });
  await page.keyboard.press("Meta+p");
  const skeleton = page.getByTestId("panel-skeleton");
  await expect(skeleton).toBeVisible();
  await expect(page.getByTestId("panel-empty")).toHaveCount(0);
  const skeletonHeights = await skeleton.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>(".panel-row")].map((row) => row.offsetHeight),
  );
  expect(skeletonHeights.length).toBeGreaterThan(1);
  for (const height of skeletonHeights) expect(height).toBeGreaterThanOrEqual(40);
  expect(await skeleton.getAttribute("aria-hidden")).toBe("true");
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  await expect(skeleton).toHaveCount(0);
  const rowHeight = await page
    .getByTestId("browse-row")
    .first()
    .evaluate((el) => (el as HTMLElement).offsetHeight);
  expect(rowHeight).toBe(skeletonHeights[0]);

  // A later search keeps the rows on screen while it loads.
  await page.keyboard.type("Alpha");
  await page.waitForTimeout(200);
  await expect(skeleton).toHaveCount(0);
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  await expect(page.getByTestId("browse-row")).toHaveCount(1);
});

test("a hung browse keeps the skeleton and never flashes an empty or error state", async ({ page }) => {
  await openWithFaults(page, "mockHang=notes.browse");
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("panel-skeleton")).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.getByTestId("panel-skeleton")).toBeVisible();
  await expect(page.getByTestId("panel-empty")).toHaveCount(0);
  await expect(page.getByTestId("panel-error")).toHaveCount(0);
});

test("a failed browse says so, and Enter or Try Again retries", async ({ page }) => {
  await openWithFaults(page, "mockFail=notes.browse");
  await page.keyboard.press("Meta+p");
  const error = page.getByTestId("panel-error");
  await expect(error).toContainText("Could Not Load Notes");
  await expect(error).toHaveAttribute("role", "alert");
  await expect(page.getByTestId("panel-empty")).toHaveCount(0);
  await expect(page.locator(".panel-search")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  await expect(error).toHaveCount(0);

  // The button retries too.
  await page.keyboard.press("Escape");
  await mock(page, { fail: "notes.browse" });
  await page.keyboard.press("Meta+p");
  await expect(error).toContainText("Could Not Load Notes");
  await error.getByRole("button", { name: "Try Again" }).click();
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  await expect(error).toHaveCount(0);
});

test("a failed search with rows shown keeps the rows", async ({ page }) => {
  await openHarness(page, NOTES);
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  await mock(page, { fail: "notes.browse" });
  await page.keyboard.type("A");
  await page.waitForTimeout(200);
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  await expect(page.getByTestId("panel-error")).toHaveCount(0);
  await expect(page.getByTestId("panel-empty")).toHaveCount(0);
});

test("Recently Deleted shows skeletons on its first load and retries after a failure", async ({ page }) => {
  await openHarness(page, NOTES);
  await page.keyboard.press("Control+x");
  await mock(page, { latency: 600 });
  await page.keyboard.press("Meta+k");
  await page.getByTestId("action-deleted").click();
  await expect(page.getByTestId("command-panel")).toHaveAttribute("data-view", "deleted");
  await expect(page.getByTestId("panel-skeleton")).toBeVisible();
  await expect(page.getByTestId("panel-empty")).toHaveCount(0);
  await expect(page.getByTestId("deleted-row")).toHaveCount(1);
  await expect(page.getByTestId("panel-skeleton")).toHaveCount(0);
  await mock(page, { latency: 5 });

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
  await mock(page, { fail: "notes.listDeleted" });
  await page.keyboard.press("Meta+k");
  await page.getByTestId("action-deleted").click();
  await expect(page.getByTestId("panel-error")).toContainText("Could Not Load Deleted Notes");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("deleted-row")).toHaveCount(1);
  await expect(page.getByTestId("panel-error")).toHaveCount(0);
});

test("Search reads Pinned then Recent with aligned titles, the Current label, and a preview of the highlighted note", async ({
  page,
}) => {
  await openHarness(page, NOTES);
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  // Measure after the entrance animation: mid animation the bounding boxes are scaled.
  await settle(page);
  const surface = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-testid=command-panel]")!;
    const app = document.querySelector<HTMLElement>("[data-testid=app]")!;
    const rows = [...panel.querySelectorAll<HTMLElement>("[data-testid=browse-row]")];
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return {
      sections: [...panel.querySelectorAll(".menu-section")].map((el) => el.textContent?.trim()),
      titleLefts: rows.map((row) => row.querySelector(".panel-row-title")!.getBoundingClientRect().left),
      // Layout width: the entrance animation scales the bounding box. 700 points, or the panel less 12 a side.
      width: panel.offsetWidth,
      expected: Math.min((700 / 14) * rem, app.offsetWidth - 24),
    };
  });
  expect(surface.sections).toEqual(["Pinned", "Recent"]);
  expect(surface.titleLefts[0]).toBe(surface.titleLefts[1]);
  expect(Math.abs(surface.width - surface.expected)).toBeLessThan(1);
  await expect(page.getByTestId("browse-row").first()).toContainText("Current");

  // Pointing at a row selects it, and the preview follows.
  const second = page.getByTestId("browse-row").nth(1);
  await second.hover();
  await expect(second).toHaveClass(/is-selected/);
  const secondTitle = (await second.locator(".panel-row-title").textContent()) ?? "";
  await expect(page.getByTestId("search-preview").locator(".search-preview-title")).toHaveText(secondTitle);

  // With nothing pinned, every note is under Recent.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  await expect(page.locator(".panel .menu-section")).toHaveText(["Recent"]);
});

test("roving tabindex: one tabbable row, no tabbable row buttons, Tab reaches the selected row", async ({ page }) => {
  await openHarness(page, NOTES);
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  const search = page.locator(".panel-search");
  await expect(search).toBeFocused();
  expect(await tabbable(page)).toEqual({ options: 1, selectedIsTabbable: true, rowButtons: 0 });
  await page.keyboard.press("ArrowDown");
  await expect(search).toBeFocused();
  expect(await tabbable(page)).toEqual({ options: 1, selectedIsTabbable: true, rowButtons: 0 });

  await page.keyboard.press("Tab");
  const selected = page.locator("[data-testid=browse-row].is-selected");
  await expect(selected).toBeFocused();
  expect((await ring(page)).shadow).not.toBe("none");
  // The list leaves room for the whole ring: nothing of it is clipped at the sides.
  const room = await selected.evaluate((row) => {
    const list = row.closest(".panel-list")!;
    const style = getComputedStyle(list);
    const a = row.getBoundingClientRect();
    const b = list.getBoundingClientRect();
    const ring = parseFloat(getComputedStyle(row).boxShadow.split(/\)\s/).pop()!.split(" ")[3]!);
    return { left: a.left - b.left - ring, right: b.right - a.right - ring, overflow: style.overflowX };
  });
  expect(room.left).toBeGreaterThanOrEqual(-0.5);
  expect(room.right).toBeGreaterThanOrEqual(-0.5);
  // The arrows carry focus with the selection.
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("browse-row").first()).toBeFocused();
  await expect(page.getByTestId("browse-row").first()).toHaveAttribute("tabindex", "0");

  // Actions, Recently Deleted, and Settings rove the same way.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+k");
  await expect(search).toBeFocused();
  expect(await tabbable(page)).toEqual({ options: 1, selectedIsTabbable: true, rowButtons: 0 });
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("action-duplicate")).toBeFocused();
  expect((await ring(page)).shadow).not.toBe("none");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("[data-testid=command-panel] [role=option].is-selected")).toBeFocused();
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+x");
  await page.keyboard.press("Meta+k");
  await page.getByTestId("action-deleted").click();
  await expect(page.getByTestId("deleted-row")).toHaveCount(1);
  expect(await tabbable(page)).toEqual({ options: 1, selectedIsTabbable: true, rowButtons: 0 });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // Settings keeps focus in its search field, which names the picked row as its active descendant.
  await page.keyboard.press("Meta+Comma");
  const settingsSearch = page.getByTestId("settings-search");
  await expect(settingsSearch).toBeFocused();
  await expect(page.getByTestId("settings").locator("[tabindex='0']")).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(settingsSearch).toHaveAttribute("aria-activedescendant", "setting-row-floatOnTop");
  await expect(page.locator("#setting-row-floatOnTop")).toHaveAttribute("aria-selected", "true");
});

test("roving tabindex in the format menu, slash menu, and emoji picker", async ({ page }) => {
  await openHarness(page, ["Hello"]);
  await page.keyboard.press("Alt+Meta+Comma");
  await page.getByRole("button", { name: "Heading" }).click();
  await expect(page.locator(".menu")).toBeVisible();
  const menu = await tabbable(page, ".menu");
  expect(menu.options).toBe(1);

  await page.keyboard.press("Escape");
  await page.locator(".note-editor").focus();
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  const slashFirst = await tabbable(page, "[data-testid=slash-menu]");
  await page.keyboard.press("ArrowDown");
  const slashNext = await tabbable(page, "[data-testid=slash-menu]");
  expect([slashFirst.options, slashFirst.selectedIsTabbable, slashNext.options, slashNext.selectedIsTabbable]).toEqual([
    1,
    true,
    1,
    true,
  ]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Backspace");

  await page.keyboard.type(" :");
  const picker = page.getByTestId("emoji-picker");
  await expect(picker.getByRole("option")).toHaveCount(6);
  const cells = await tabbable(page, "[data-testid=emoji-picker]");
  expect(cells).toEqual({ options: 1, selectedIsTabbable: true, rowButtons: 0 });
  const openButton = picker.getByRole("button", { name: "Open Emoji Picker" });
  await expect(openButton).toHaveAttribute("tabindex", "-1");
  for (let step = 0; step < 6; step++) await page.keyboard.press("ArrowRight");
  await expect(openButton).toHaveAttribute("tabindex", "0");
  await expect(picker.locator(".emoji-cell[tabindex='0']")).toHaveCount(0);
});

test("every action in All actions carries one icon before its title, submenus and placement included", async ({
  page,
}) => {
  await openHarness(page, NOTES);
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("action-duplicate")).toBeVisible();
  const collect = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-testid=command-panel] [role=option]")].map((row) => {
        const first = row.firstElementChild!;
        return {
          id: row.dataset.testid,
          leadingIcon: first.matches("svg.icon"),
          before:
            first.getBoundingClientRect().right <= row.querySelector(".panel-row-title")!.getBoundingClientRect().left,
        };
      }),
    );
  // Each submenu fills the right pane while it is highlighted.
  const rows = new Map<string, { leadingIcon: boolean; before: boolean }>();
  for (const id of ["share", "go", "window", "zoom"]) {
    await page.getByTestId(`submenu-${id}`).hover();
    await expect(page.getByTestId("search-submenu")).toBeVisible();
    for (const row of await collect()) rows.set(row.id ?? "", row);
  }
  expect(rows.size).toBeGreaterThan(20);
  for (const id of ["action-fillLeft", "action-fillRight", "action-fillScreen", "action-centre"])
    expect([...rows.keys()]).toContain(id);
  expect([...rows].filter(([, row]) => !row.leadingIcon || !row.before)).toEqual([]);

  // The placement actions still run from the panel.
  await page.locator(".panel-search").fill("Fill Left");
  await expect(page.getByTestId("action-fillLeft")).toHaveClass(/is-selected/);
  await page.keyboard.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __overnoteMock: { store: { placeCalls: string[] } } }).__overnoteMock.store
            .placeCalls,
      ),
    )
    .toEqual(["left"]);
});

test("the confirmation dialog names its message as the description", async ({ page }) => {
  await openHarness(page, NOTES);
  await page.keyboard.press("Control+Shift+x");
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  const id = await dialog.getAttribute("aria-describedby");
  expect(id).toBeTruthy();
  await expect(page.locator(`#${id}`)).not.toBeEmpty();
  await expect(dialog.locator(`#${id}`)).toHaveCount(1);
});
