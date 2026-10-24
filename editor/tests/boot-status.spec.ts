/** The slow boot status: shown only when the app stays unready for 300 ms. */
import { expect, test, type Page } from "@playwright/test";

/** Sets the mock's latency or hang list the moment the harness installs it, before the app asks. */
async function configureMock(page: Page, config: { latency?: number; hang?: string[] }): Promise<void> {
  await page.addInitScript((cfg) => {
    let value: unknown;
    Object.defineProperty(window, "__overnoteMock", {
      configurable: true,
      get: () => value,
      set: (next: { latency: number; hang: Set<string> }) => {
        if (cfg.latency !== undefined) next.latency = cfg.latency;
        for (const method of cfg.hang ?? []) next.hang.add(method);
        value = next;
      },
    });
  }, config);
}

test("a fast boot never shows the status", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __seen: boolean }).__seen = false;
    new MutationObserver(() => {
      if (document.querySelector("[data-testid=boot-status]")) (window as unknown as { __seen: boolean }).__seen = true;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto("/?seed=empty");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.waitForTimeout(450);
  expect(await page.evaluate(() => (window as unknown as { __seen: boolean }).__seen)).toBe(false);
  await expect(page.getByTestId("boot-status")).toHaveCount(0);
});

test("a boot slower than 300 ms shows the status until ready, then removes it", async ({ page }) => {
  await configureMock(page, { latency: 700 });
  const start = Date.now();
  await page.goto("/?seed=empty");
  const status = page.getByTestId("boot-status");
  await expect(status).toHaveText("Loading your notes");
  await expect(status).toHaveAttribute("role", "status");
  expect(Date.now() - start).toBeLessThan(1500);
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await expect(status).toHaveCount(0);
});

test("a hung system.ready keeps the status", async ({ page }) => {
  await configureMock(page, { hang: ["system.ready"] });
  await page.goto("/?seed=empty");
  const status = page.getByTestId("boot-status");
  await expect(status).toHaveText("Loading your notes");
  await page.waitForTimeout(1500);
  await expect(status).toHaveCount(1);
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "false");
});
