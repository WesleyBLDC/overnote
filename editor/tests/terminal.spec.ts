/**
 * The terminal drawer end to end in the harness: the mock bridge stands in for the helper's PTY with a
 * line-discipline echo (src/dev/mockBridge.ts), so these flows cover everything the page does: the toolbar
 * button, ⌃`, ⌘K, the panel growing by the drawer, typing and acks on the fast lane, the key allowlist, and the
 * remembered open state.
 */
import { expect, test, type Page } from "@playwright/test";
import { calls, clearCalls, docJSON, editor, openHarness } from "./harness";

interface MockTerminal {
  live: boolean;
  opens: number;
  written: string;
  sent: number;
  acked: number;
  size: { cols: number; rows: number } | null;
  drawer: number;
}

const drawer = (page: Page) => page.getByTestId("terminal-drawer");

async function terminalMock(page: Page): Promise<MockTerminal> {
  return page.evaluate(() => {
    const { terminal } = (window as unknown as { __overnoteMock: { terminal: MockTerminal } }).__overnoteMock;
    return { ...terminal };
  });
}

async function rootHeight(page: Page): Promise<number> {
  return page.evaluate(() => document.getElementById("root")!.getBoundingClientRect().height);
}

async function appHeight(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector(".app")!.getBoundingClientRect().height);
}

/** The terminal's visible text, row by row (xterm.js's DOM renderer). */
async function screenText(page: Page): Promise<string> {
  return page.locator(".terminal-drawer .xterm-rows").innerText();
}

const focusInTerminal = (page: Page) =>
  page.evaluate(() => document.activeElement?.closest(".terminal-drawer") !== null);

async function openWithButton(page: Page): Promise<void> {
  await page.getByTestId("toolbar").hover();
  await page.getByTestId("terminal").click();
  await expect(drawer(page)).toBeVisible();
  await expect(page.locator(".terminal-drawer .xterm-rows")).toContainText("overnote-mock $");
  await expect.poll(() => focusInTerminal(page)).toBe(true);
}

test("the Terminal button opens the drawer below the note and the panel grows by 260 points", async ({ page }) => {
  await openHarness(page, ["# Weekend project\n\nBuild a tiny CLI."]);
  const before = { root: await rootHeight(page), app: await appHeight(page) };
  await expect(drawer(page)).toBeHidden();
  await openWithButton(page);

  expect(await calls(page, "window.setDrawer")).toMatchObject([{ params: { height: 260 } }]);
  expect(await rootHeight(page)).toBe(before.root + 260);
  // The note keeps its size: the drawer takes only the space the panel grew by.
  expect(await appHeight(page)).toBe(before.app);
  await expect(page.getByTestId("terminal")).toHaveAttribute("aria-pressed", "true");
  const opened = await calls(page, "term.open");
  expect(opened).toHaveLength(1);
  const size = opened[0]?.params as { cols: number; rows: number };
  expect(size.cols).toBeGreaterThanOrEqual(40);
  expect(size.rows).toBeGreaterThanOrEqual(10);
  expect((await calls(page, "settings.set")).at(-1)?.params).toEqual({ terminal: { open: true } });

  // The same button closes it, gives the space back, and puts the caret in the note.
  await page.getByTestId("terminal").click();
  await expect(drawer(page)).toBeHidden();
  expect((await calls(page, "window.setDrawer")).at(-1)?.params).toEqual({ height: 0 });
  expect(await rootHeight(page)).toBe(before.root);
  expect(await appHeight(page)).toBe(before.app);
  await expect(editor(page)).toBeFocused();
  // Closing only hides: the attach stays for a quick reopen.
  expect(await calls(page, "term.close")).toHaveLength(0);
});

test("typing reaches the shell on the fast lane and every byte drawn is acked", async ({ page }) => {
  await openHarness(page, ["Note"]);
  await openWithButton(page);
  await clearCalls(page);
  await page.keyboard.type("echo hi");
  await page.keyboard.press("Enter");
  await expect.poll(() => screenText(page)).toContain("overnote-mock $ echo hi");
  const mock = await terminalMock(page);
  expect(mock.written).toBe("echo hi\r");
  await expect.poll(async () => (await terminalMock(page)).acked).toBe((await terminalMock(page)).sent);
  // Keystrokes never use the main bridge, so they cannot queue behind a note save.
  expect((await calls(page)).filter((call) => call.method.startsWith("term."))).toEqual([]);
});

test("keys that are Overnote shortcuts elsewhere go to the shell while the terminal has focus", async ({ page }) => {
  await openHarness(page, ["# Keep me\n\nThis note must survive."]);
  const doc = await docJSON(page);
  await openWithButton(page);
  await clearCalls(page);

  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+x");
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+d");
  await expect.poll(async () => (await terminalMock(page)).written).toBe("\x1b\x18");

  const sent = (await calls(page)).map((call) => call.method);
  expect(sent).not.toContain("window.hide");
  expect(sent).not.toContain("notes.delete");
  expect(sent).not.toContain("notes.duplicate");
  expect(await docJSON(page)).toEqual(doc);
  await expect(drawer(page)).toBeVisible();
  expect(await focusInTerminal(page)).toBe(true);

  // The allowlist still reaches Overnote: ⌘K opens the command panel from the terminal.
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("command-panel")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("⌃` opens the drawer from the note and closes it from the terminal", async ({ page }) => {
  await openHarness(page, ["Note"]);
  await page.keyboard.press("Control+Backquote");
  await expect(drawer(page)).toBeVisible();
  await expect.poll(() => focusInTerminal(page)).toBe(true);
  await expect(page.locator(".terminal-drawer .xterm-rows")).toContainText("overnote-mock $");

  // From the note with the drawer open, ⌃` only moves focus to the terminal.
  await editor(page).focus();
  await page.keyboard.press("Control+Backquote");
  await expect.poll(() => focusInTerminal(page)).toBe(true);
  await expect(drawer(page)).toBeVisible();

  await page.keyboard.press("Control+Backquote");
  await expect(drawer(page)).toBeHidden();
  await expect(editor(page)).toBeFocused();
  // The shell never sees the toggle.
  expect((await terminalMock(page)).written).toBe("");
});

test("⌘K offers Open Terminal and Close Terminal", async ({ page }) => {
  await openHarness(page, ["Note"]);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("terminal");
  await expect(page.getByRole("option", { name: /Open Terminal/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(drawer(page)).toBeVisible();
  await expect.poll(() => focusInTerminal(page)).toBe(true);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("terminal");
  await expect(page.getByRole("option", { name: /Close Terminal/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(drawer(page)).toBeHidden();
});

test("an open drawer comes back after a reload without taking focus from the note", async ({ page }) => {
  await page.goto(
    `/?seed=${encodeURIComponent(JSON.stringify(["Note"]))}&settings=${encodeURIComponent('{"terminal":{"open":true}}')}`,
  );
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await expect(drawer(page)).toBeVisible();
  await expect(page.locator(".terminal-drawer .xterm-rows")).toContainText("overnote-mock $");
  expect(await calls(page, "term.open")).toHaveLength(1);
  await expect(editor(page)).toBeFocused();
});

test("a closed drawer ends its attach after five idle minutes, and reopening attaches again", async ({ page }) => {
  await page.clock.install();
  await openHarness(page, ["Note"]);
  await openWithButton(page);
  await page.keyboard.press("Control+Backquote");
  await expect(drawer(page)).toBeHidden();
  await page.clock.fastForward("04:59");
  expect(await calls(page, "term.close")).toHaveLength(0);
  await page.clock.fastForward("00:02");
  await expect.poll(async () => (await calls(page, "term.close")).length).toBe(1);
  expect((await terminalMock(page)).live).toBe(false);

  await page.keyboard.press("Control+Backquote");
  await expect(drawer(page)).toBeVisible();
  await expect.poll(async () => (await terminalMock(page)).opens).toBe(2);
});

test("an exit says so, and the next key starts the shell again", async ({ page }) => {
  await openHarness(page, ["Note"]);
  await openWithButton(page);
  await page.evaluate(() =>
    (window as unknown as { __overnoteMock: { terminal: { exit(code: number): void } } }).__overnoteMock.terminal.exit(
      0,
    ),
  );
  await expect.poll(() => screenText(page)).toContain("The shell exited with code 0");
  await page.keyboard.press("a");
  await expect.poll(async () => (await terminalMock(page)).opens).toBe(2);
  // The key that restarted it is not typed into the new shell.
  expect((await terminalMock(page)).written).toBe("");
});
