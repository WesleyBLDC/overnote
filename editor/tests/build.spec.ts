/** The shipped bundle in assets/editor boots against a stub native side and stays offline. */
import { expect, test } from "@playwright/test";

test("production build boots, renders, and makes no external requests", async ({ page }) => {
  const external: string[] = [];
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:5198/")) external.push(request.url());
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const note = {
      id: "01J0000000000000000000000A",
      rawContent: JSON.stringify({
        type: "doc",
        content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Shipped" }] }],
      }),
      markdown: "# Shipped",
      text: "Shipped",
      title: "Shipped",
      pinned: null,
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      lastAccessedAt: 1,
      caretPosition: 0,
    };
    const sent: string[] = [];
    (window as unknown as { __sent: string[] }).__sent = sent;
    (window as unknown as { webkit: unknown }).webkit = {
      messageHandlers: {
        overnote: {
          postMessage(message: { id: number; method: string }) {
            sent.push(message.method);
            const results: Record<string, unknown> = {
              "system.ready": {
                settings: {
                  escapeLosesFocus: false,
                  hideWhileScreenSharing: false,
                  zoom: 1,
                  windowAutoSize: true,
                  showFormatBar: false,
                  countMode: "characters",
                  panelFrame: null,
                },
                windowData: { current: note, previousNoteId: null, nextNoteId: null, pinnedShortcutNoteIds: [] },
              },
            };
            const bridge = (window as unknown as { overnoteBridge: { resolve(id: number, r: unknown): void } })
              .overnoteBridge;
            setTimeout(() => bridge.resolve(message.id, results[message.method] ?? {}), 1);
          },
        },
      },
    };
  });
  await page.goto("http://127.0.0.1:5198/index.html");
  await expect(page.getByTestId("title")).toHaveText("Shipped");
  await expect(page.locator(".note-editor h1")).toHaveText("Shipped");
  const sent = () => page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
  expect((await sent())[0]).toBe("system.ready");
  await expect.poll(sent).toContain("window.resize");
  expect(await page.locator('meta[http-equiv="Content-Security-Policy"]').count()).toBe(1);
  expect(await page.locator("script[crossorigin]").count()).toBe(0);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});
