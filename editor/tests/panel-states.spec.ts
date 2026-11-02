/** Honest loading and error states for browse, Recently Deleted, and boot. */
import { expect, test } from "@playwright/test";
import { editor, openHarness } from "./harness";

const mock = (page: import("@playwright/test").Page, fn: string) =>
  page.evaluate((code) => {
    const control = (window as unknown as { __overnoteMock: Record<string, unknown> }).__overnoteMock;
    if (code === "latency") control.latency = 500;
    if (code === "hang-browse") (control.hang as Set<string>).add("notes.browse");
    if (code === "fail-browse") (control.failNext as Record<string, number>)["notes.browse"] = 500;
    if (code === "fail-deleted") (control.failNext as Record<string, number>)["notes.listDeleted"] = 500;
    if (code === "normal") control.latency = 5;
  }, fn);

test("browse shows inert skeletons while the first load is pending, then the loaded rows", async ({ page }) => {
  await openHarness(page, ["# Alpha\n\nFirst", "# Beta\n\nSecond"]);
  await mock(page, "latency");
  await page.keyboard.press("Meta+p");
  const skeleton = page.getByTestId("panel-skeleton");
  await expect(skeleton).toBeVisible();
  await expect(page.getByTestId("panel-empty")).toHaveCount(0);
  await expect(page.getByTestId("browse-row")).toHaveCount(0);
  const geometry = await skeleton.evaluate((el) => {
    const rows = [...el.querySelectorAll(".panel-row")];
    return rows.map((row) => Math.round(row.getBoundingClientRect().height));
  });
  expect(geometry.length).toBeGreaterThan(1);
  expect(geometry.every((height) => height >= 40)).toBe(true);
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  await expect(skeleton).toHaveCount(0);
  await mock(page, "normal");
  await page.keyboard.type("Alpha");
  await expect(page.getByTestId("browse-row")).toHaveCount(1);
  await expect(skeleton).toHaveCount(0);
});

test("browse hang keeps the skeleton and never flashes an empty state", async ({ page }) => {
  await openHarness(page, ["# Alpha\n\nFirst"]);
  await mock(page, "hang-browse");
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("panel-skeleton")).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.getByTestId("panel-skeleton")).toBeVisible();
  await expect(page.getByTestId("panel-empty")).toHaveCount(0);
  await expect(page.getByTestId("panel-error")).toHaveCount(0);
});

test("browse failure shows an error with Try Again and retry loads the rows", async ({ page }) => {
  await openHarness(page, ["# Alpha\n\nFirst", "# Beta\n\nSecond"]);
  await mock(page, "fail-browse");
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("panel-error")).toContainText("Could Not Load Notes");
  await page.getByRole("button", { name: "Try Again" }).click();
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  await expect(page.getByTestId("panel-error")).toHaveCount(0);
});

test("deleted notes show skeletons while loading and an error with retry after a failure", async ({ page }) => {
  await openHarness(page, ["# Alpha\n\nFirst"]);
  await page.keyboard.press("Control+x");
  await mock(page, "latency");
  await page.keyboard.press("Meta+k");
  await page.getByTestId("action-deleted").click();
  await expect(page.getByTestId("command-panel")).toHaveAttribute("data-view", "deleted");
  await expect(page.getByTestId("panel-skeleton")).toBeVisible();
  await expect(page.getByTestId("deleted-row")).toHaveCount(1);
  await expect(page.getByTestId("panel-skeleton")).toHaveCount(0);
  await mock(page, "normal");

  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-panel")).toHaveCount(0);
  await mock(page, "fail-deleted");
  await page.keyboard.press("Meta+k");
  await page.getByTestId("action-deleted").click();
  await expect(page.getByTestId("panel-error")).toContainText("Could Not Load Deleted Notes");
  await page.getByRole("button", { name: "Try Again" }).click();
  await expect(page.getByTestId("deleted-row")).toHaveCount(1);
});

test("browse is one surface with pin slots, counts, current label, and row buttons", async ({ page }) => {
  await openHarness(page, ["# Alpha\n\nFirst", "# Beta\n\nSecond"]);
  await page.keyboard.press("Meta+Shift+p");
  await page.keyboard.press("Meta+p");
  await expect(page.getByTestId("browse-row")).toHaveCount(2);
  const surface = await page.evaluate(() => {
    const sections = [...document.querySelectorAll(".panel-section")].map((el) =>
      [...el.children].map((child) => child.textContent?.trim()).join(" "),
    );
    const rows = [...document.querySelectorAll<HTMLElement>("[data-testid=browse-row]")];
    const titles = rows.map((row) => Math.round(row.querySelector(".panel-row-title")!.getBoundingClientRect().left));
    const leading = rows.map((row) => row.querySelector(".panel-row-leading")?.querySelector("svg") !== null);
    const panel = document.querySelector("[data-testid=command-panel]")!.getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { sections, titles, leading, panelWidthRem: panel.width / rem };
  });
  expect(surface.sections).toEqual(["Pinned 1", "Notes 1"]);
  expect(surface.leading).toEqual([true, false]);
  expect(surface.titles[0]).toBe(surface.titles[1]);
  expect(surface.panelWidthRem).toBeLessThanOrEqual(24.1);
  await expect(page.getByTestId("browse-row").first()).toContainText("Current");

  const second = page.getByTestId("browse-row").nth(1);
  await second.hover();
  await expect(second.locator(".panel-row-buttons")).toBeVisible();
  await expect(second.getByRole("button", { name: "Pin Note" })).toBeVisible();
  await expect(second.getByRole("button", { name: "Delete Note" })).toBeVisible();

  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("action-new").locator("svg")).toHaveCount(1);
  await expect(page.getByTestId("action-browse").locator("svg").first()).toBeVisible();
  const danger = await page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    probe.style.color = "var(--danger)";
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  const unselected = await page
    .getByTestId("action-delete")
    .evaluate((el) => getComputedStyle(el.querySelector(".panel-row-title")!).color);
  expect(unselected).not.toBe(danger);
  await page.getByTestId("command-panel").locator(".panel-search").fill("Delete Note");
  await expect(page.getByTestId("action-delete")).toHaveClass(/is-selected/);
  const selectedDanger = await page
    .getByTestId("action-delete")
    .evaluate((el) => getComputedStyle(el.querySelector(".panel-row-title")!).color);
  expect(selectedDanger).toBe(danger);
});

test("a slow boot explains itself after a delay and a fast boot shows nothing", async ({ page }) => {
  await page.goto("/?seed=empty&mockLatency=700");
  await expect(page.getByTestId("boot-status")).toHaveCount(0);
  await expect(page.getByTestId("boot-status")).toContainText("Loading your notes");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("boot-status")).toHaveCount(0);
  await expect(editor(page)).toBeVisible();
});

test("a hung boot keeps the quiet status until it is ready", async ({ page }) => {
  await page.goto("/?seed=empty&mockHang=system.ready");
  await expect(page.getByTestId("boot-status")).toContainText("Loading your notes");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "false");
});
