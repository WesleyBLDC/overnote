/** The command panel as one surface: loading and error states, roving focus, sections, and action icons. */
import { expect, test, type Page } from "@playwright/test";
import { openHarness } from "./harness";

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

test("browse reads Pinned and Notes with aligned titles, the Current label, and the panel width", async ({ page }) => {
  await openHarness(page, NOTES);
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  const surface = await page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-testid=command-panel]")!;
    const rows = [...panel.querySelectorAll<HTMLElement>("[data-testid=browse-row]")];
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const width = getComputedStyle(document.documentElement).getPropertyValue("--panel-width");
    return {
      sections: [...panel.querySelectorAll(".menu-section")].map((el) => el.textContent?.trim()),
      leadingPin: rows.map((row) => row.querySelector(".panel-row-leading svg") !== null),
      titleLefts: rows.map((row) => row.querySelector(".panel-row-title")!.getBoundingClientRect().left),
      // Layout width: the entrance animation scales the bounding box.
      panelWidthRem: panel.offsetWidth / rem,
      tokenRem: parseFloat(width),
    };
  });
  expect(surface.sections).toEqual(["Pinned", "Notes"]);
  expect(surface.leadingPin).toEqual([true, false]);
  expect(surface.titleLefts[0]).toBe(surface.titleLefts[1]);
  expect(Math.abs(surface.panelWidthRem - surface.tokenRem)).toBeLessThan(0.05);
  await expect(page.getByTestId("browse-row").first()).toContainText("Current");

  // Only the selected row has its buttons; pointing at a row selects it.
  await expect(page.locator(".panel-row-buttons")).toHaveCount(1);
  const second = page.getByTestId("browse-row").nth(1);
  await second.hover();
  await expect(second).toHaveClass(/is-selected/);
  await expect(second.getByRole("button", { name: "Pin Note" })).toBeVisible();
  await expect(second.getByRole("button", { name: "Delete Note" })).toBeVisible();
  await expect(page.locator(".panel-row-buttons")).toHaveCount(1);

  // With nothing pinned there is no leading slot, so titles start where the search text does.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  await expect(page.locator(".panel-row-leading")).toHaveCount(0);
  await expect(page.locator(".panel .menu-section")).toHaveText(["Notes"]);
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
  await expect(page.getByTestId("action-new")).toBeFocused();
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

  await page.keyboard.press("Meta+Comma");
  await expect(page.getByTestId("command-panel")).toHaveAttribute("data-view", "settings");
  expect(await tabbable(page)).toEqual({ options: 1, selectedIsTabbable: true, rowButtons: 0 });
  await page.keyboard.press("ArrowDown");
  expect(await tabbable(page)).toEqual({ options: 1, selectedIsTabbable: true, rowButtons: 0 });
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

test("every root action carries one icon before its title, placement actions included", async ({ page }) => {
  await openHarness(page, NOTES);
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("action-new")).toBeVisible();
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-testid=command-panel] [data-testid^=action-]")].map((row) => {
      const first = row.firstElementChild!;
      return {
        id: row.dataset.testid,
        leadingIcon: first.matches("svg.icon"),
        before:
          first.getBoundingClientRect().right <= row.querySelector(".panel-row-title")!.getBoundingClientRect().left,
      };
    }),
  );
  expect(rows.length).toBeGreaterThan(20);
  for (const id of ["action-fillLeft", "action-fillRight", "action-fillScreen", "action-centre"])
    expect(rows.map((row) => row.id)).toContain(id);
  expect(rows.filter((row) => !row.leadingIcon || !row.before)).toEqual([]);

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
