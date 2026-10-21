/** Every dropdown stays inside a small panel: solid, on top, and clear of the panel's edges. */
import { expect, test, type Page } from "@playwright/test";
import { calls, openHarness, settle } from "./harness";

const NOTE = "Shopping list\n\nVisit [the market](https://example.com) early for milk, eggs, and bread.";

/** The minimum panel (405 x 197 points) and one a little larger. */
const SIZES = [
  { width: 405, height: 197 },
  { width: 480, height: 260 },
];

interface EditorApi {
  state: { doc: { child(i: number): { nodeSize: number }; descendants(f: (node: Node, pos: number) => void): void } };
  commands: { focus(): void; setTextSelection(pos: number): void };
}
interface Node {
  isText: boolean;
  marks: { type: { name: string } }[];
}

async function caretAtEndOfFirstLine(page: Page) {
  await page.evaluate(() => {
    const editor = (window as unknown as { __bnEditor: EditorApi }).__bnEditor;
    editor.commands.focus();
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize - 1);
  });
}

const DROPDOWNS: { name: string; selector: string; open(page: Page): Promise<void> }[] = [
  { name: "settings", selector: "[data-testid=command-panel]", open: (page) => page.keyboard.press("Meta+Comma") },
  { name: "actions", selector: "[data-testid=command-panel]", open: (page) => page.keyboard.press("Meta+k") },
  {
    name: "format menu",
    selector: ".menu",
    open: async (page) => {
      await page.keyboard.press("Alt+Meta+Comma");
      await page.getByRole("button", { name: "Heading" }).click();
      // Away from the panel: the format bar dims, the menu must not.
      await page.mouse.move(2, 2);
    },
  },
  {
    name: "slash menu",
    selector: "[data-testid=slash-menu]",
    open: async (page) => {
      await caretAtEndOfFirstLine(page);
      await page.keyboard.press("Enter");
      await page.keyboard.type("/");
    },
  },
  {
    name: "emoji picker",
    selector: "[data-testid=emoji-picker]",
    open: async (page) => {
      await caretAtEndOfFirstLine(page);
      await page.keyboard.type(" :sm");
    },
  },
  {
    name: "link popover",
    selector: "[data-testid=link-popover]",
    open: async (page) => {
      await page.evaluate(() => {
        const editor = (window as unknown as { __bnEditor: EditorApi }).__bnEditor;
        let pos = 0;
        editor.state.doc.descendants((node, at) => {
          if (!pos && node.isText && node.marks.some((mark) => mark.type.name === "link")) pos = at + 2;
        });
        editor.commands.focus();
        editor.commands.setTextSelection(pos);
      });
      await page.keyboard.press("Meta+l");
    },
  },
];

for (const scheme of ["light", "dark"] as const) {
  for (const { width, height } of SIZES) {
    test(`every dropdown stays inside a ${width} x ${height} panel, solid and on top (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      for (const dropdown of DROPDOWNS) {
        await openHarness(page, [NOTE]);
        await page.evaluate(
          ([w, h]) =>
            (
              window as unknown as { __overnoteMock: { setPanelSize(w: number, h: number): void } }
            ).__overnoteMock.setPanelSize(w!, h!),
          [width, height],
        );
        await page.mouse.move(320, 70);
        await dropdown.open(page);
        await expect(page.locator(dropdown.selector)).toBeVisible();
        await settle(page);
        const check = await page.locator(dropdown.selector).evaluate((element) => {
          const app = element.closest(".app")!.getBoundingClientRect();
          const box = element.getBoundingClientRect();
          // Fully opaque: no translucent ancestor, and a solid background of its own.
          let opacity = 1;
          for (let node: Element | null = element; node; node = node.parentElement) {
            opacity *= parseFloat(getComputedStyle(node).opacity);
          }
          const background = getComputedStyle(element).backgroundColor;
          const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(background)?.[1];
          // On top: nothing in the page draws over any of its corners or its middle.
          const r = parseFloat(getComputedStyle(element).borderTopLeftRadius) + 2;
          const points = [
            [box.left + r, box.top + r],
            [box.right - r, box.top + r],
            [box.left + r, box.bottom - r],
            [box.right - r, box.bottom - r],
            [(box.left + box.right) / 2, (box.top + box.bottom) / 2],
          ];
          const covered = points.filter(([x, y]) => !element.contains(document.elementFromPoint(x!, y!))).length;
          return {
            inside: {
              top: box.top - app.top,
              bottom: app.bottom - box.bottom,
              left: box.left - app.left,
              right: app.right - box.right,
            },
            opacity,
            alpha: alpha === undefined ? 1 : parseFloat(alpha),
            covered,
            height: box.height,
          };
        });
        const label = `${dropdown.name} at ${width} x ${height}`;
        // Clear of the native drag strip (12 points) and of the 10 point resize zones.
        expect(check.inside.top, label).toBeGreaterThanOrEqual(12);
        expect(check.inside.bottom, label).toBeGreaterThanOrEqual(9.5);
        expect(check.inside.left, label).toBeGreaterThanOrEqual(9.5);
        expect(check.inside.right, label).toBeGreaterThanOrEqual(9.5);
        expect(check.opacity, label).toBe(1);
        expect(check.alpha, label).toBe(1);
        expect(check.covered, label).toBe(0);
        expect(check.height, label).toBeGreaterThan(30);
        // The panel never resizes for a dropdown, so nothing can cross its edge.
        expect(
          (await calls(page, "window.resize")).filter((c) => c.params.temporary),
          label,
        ).toEqual([]);
        expect(await calls(page, "window.setOverhang"), label).toEqual([]);
      }
    });
  }
}

test("a dropdown near the bottom of a short panel opens upward and scrolls to its selection", async ({ page }) => {
  await openHarness(page, ["One\n\nTwo\n\nThree"]);
  await page.evaluate(() =>
    (window as unknown as { __overnoteMock: { setPanelSize(w: number, h: number): void } }).__overnoteMock.setPanelSize(
      405,
      197,
    ),
  );
  await page.keyboard.press("Meta+ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  const menu = page.getByTestId("slash-menu");
  await expect(menu).toHaveAttribute("data-side", "above");
  // Walk past the visible rows: the selected row scrolls into view inside the menu.
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowDown");
  const selectedInView = () =>
    menu.evaluate((element) => {
      const row = element.querySelector(".is-selected")!.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return row.top >= box.top - 0.5 && row.bottom <= box.bottom + 0.5;
    });
  // The menu scrolls smoothly, so wait for it to arrive.
  await expect.poll(selectedInView).toBe(true);
  await expect(menu.locator(".is-selected")).toHaveText(/Code Block/);
});

test("at the minimum size the command panels show at least two settings or notes rows and three actions", async ({
  page,
}) => {
  for (const [shortcut, rows] of [
    ["Meta+Comma", 2],
    ["Meta+k", 3],
    ["Meta+p", 2],
  ] as const) {
    await openHarness(page, ["One", "Two", NOTE]);
    await page.evaluate(() =>
      (
        window as unknown as { __overnoteMock: { setPanelSize(w: number, h: number): void } }
      ).__overnoteMock.setPanelSize(405, 197),
    );
    await page.keyboard.press(shortcut);
    await expect(page.locator(".panel-list")).toBeVisible();
    await settle(page);
    const visible = await page.locator(".panel-list").evaluate((list) => {
      const box = list.getBoundingClientRect();
      return Array.from(list.querySelectorAll(".panel-row")).filter((row) => {
        const r = row.getBoundingClientRect();
        return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
      }).length;
    });
    expect(visible, shortcut).toBeGreaterThanOrEqual(rows);
  }
});
