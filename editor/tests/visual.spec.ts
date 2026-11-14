/** Theme and contrast: the Graphite tokens, Geist type, code blocks, and task states, in both color schemes. */
import { expect, test, type Page } from "@playwright/test";
import { calls, editor, emit, openHarness, settle } from "./harness";

const NOTE = [
  "Hello\n\n1. one\n\n- [x] done [link](https://example.com) and `code`\n\n- [ ] todo\n\n[link](https://example.com)\n\n> quoted\n\n```js\n// a comment\nconst a = 1;\n```",
];

/** The computed color a token resolves to, read through a probe so every color syntax compares equal. */
async function token(page: Page, name: string, prop = "color"): Promise<string> {
  return page.evaluate(
    ([n, p]) => {
      const probe = document.createElement("span");
      probe.style.setProperty(p!, `var(${n})`);
      document.body.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(p!);
      probe.remove();
      return value;
    },
    [name, prop],
  );
}

const style = (page: Page, selector: string, prop: string, pseudo?: string) =>
  page.evaluate(
    ([s, p, ps]) => getComputedStyle(document.querySelector(s!)!, ps || null).getPropertyValue(p!),
    [selector, prop, pseudo ?? ""],
  );

/** The branding guide's and the editor board's values for the tokens these tests check, as WebKit computes them. */
const SCHEMES = {
  light: {
    panel: "rgb(251, 251, 252)",
    accent: "rgb(39, 39, 42)",
    strong: "rgb(24, 24, 27)",
    onAccent: "rgb(255, 255, 255)",
    selection: "rgba(24, 24, 27, 0.14)",
    underline: "rgba(24, 24, 27, 0.35)",
    secondary: "rgb(95, 97, 104)",
    tertiary: "rgb(107, 110, 117)",
    sunken: "rgb(241, 241, 243)",
    code: "rgb(237, 237, 240)",
    quote: "rgb(58, 61, 67)",
    quoteBar: "rgba(0, 0, 0, 0.18)",
    ring: "rgb(180, 182, 187)",
  },
  dark: {
    panel: "rgb(24, 24, 26)",
    accent: "rgb(228, 228, 231)",
    strong: "rgb(255, 255, 255)",
    onAccent: "rgb(24, 24, 26)",
    selection: "rgba(255, 255, 255, 0.18)",
    underline: "rgba(255, 255, 255, 0.35)",
    secondary: "rgb(161, 161, 168)",
    tertiary: "rgb(142, 142, 149)",
    sunken: "rgb(17, 17, 19)",
    code: "rgb(38, 38, 42)",
    quote: "rgb(212, 212, 216)",
    quoteBar: "rgba(255, 255, 255, 0.22)",
    ring: "rgb(90, 90, 96)",
  },
} as const;

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openHarness(page, NOTE);
    });

    test("accent: the panel, links, ordered numbers, task boxes, quotes, and the selection use Graphite", async ({
      page,
    }) => {
      const want = SCHEMES[scheme];
      expect(await style(page, "[data-testid=app]", "background-color")).toBe(want.panel);
      expect(await token(page, "--accent")).toBe(want.accent);
      expect(await token(page, "--accent-strong")).toBe(want.strong);
      expect(await token(page, "--selection", "background-color")).toBe(want.selection);
      expect(await style(page, ".note-editor > p a, .note-editor > .prosemirror-flat-list ~ p a", "color")).toBe(
        want.strong,
      );
      expect(await style(page, ".note-editor p a", "text-decoration-color")).toBe(want.underline);
      expect(await style(page, ".note-editor p a", "text-decoration-line")).toContain("underline");
      const ordered = ".note-editor [data-list-kind=ordered]";
      expect(await style(page, ordered, "color", "::before")).toBe(want.accent);
      expect(await style(page, ordered, "font-weight", "::before")).toBe("600");
      // Task boxes: a ring when open; the accent fill with the check in --on-accent when done.
      const open = ".note-editor [data-list-kind=task]:not([data-list-checked]) input";
      expect(await style(page, open, "box-shadow")).toContain(want.ring);
      expect(await style(page, open, "width")).toBe("16px");
      const done = ".note-editor [data-list-kind=task][data-list-checked] input";
      expect(await style(page, done, "background-color")).toBe(want.accent);
      expect(await style(page, done, "background-color", "::after")).toBe(want.onAccent);
      // Quotes: a bar, no box, and the quote text color.
      expect(await style(page, ".note-editor blockquote", "color")).toBe(want.quote);
      expect(await style(page, ".note-editor blockquote", "border-left-width")).toBe("0px");
      expect(await style(page, ".note-editor blockquote", "background-color", "::before")).toBe(want.quoteBar);
      expect(await style(page, ".note-editor blockquote", "width", "::before")).toBe("3px");
    });

    test("code and tasks: sunken blocks, code chips, secondary comments, and struck through done tasks", async ({
      page,
    }) => {
      const want = SCHEMES[scheme];
      expect(await style(page, ".note-editor .code-block", "background-color")).toBe(want.sunken);
      expect(await style(page, ".note-editor .code-block", "box-shadow")).toContain("inset");
      expect(await style(page, ".note-editor p code", "background-color")).toBe(want.code);
      expect(await style(page, ".note-editor .hljs-comment", "color")).toBe(want.secondary);

      const checked = ".note-editor [data-list-kind=task][data-list-checked] > .list-content > p";
      expect(await style(page, checked, "color")).toBe(want.tertiary);
      expect(await style(page, checked, "text-decoration-line")).toBe("line-through");
      expect(await style(page, checked, "opacity")).toBe("1");
      expect(await style(page, `${checked} a`, "color")).toBe(want.tertiary);
      expect(await style(page, `${checked} code`, "opacity")).toBe("1");
    });

    test("normal state: placeholder in tertiary text, snapshot", async ({ page }) => {
      await openHarness(page);
      expect(await style(page, ".note-editor .is-empty", "color", "::before")).toBe(SCHEMES[scheme].tertiary);
      await openHarness(page, NOTE);
      await page.mouse.move(5, 5);
      await expect(editor(page)).toHaveScreenshot(`note-${scheme}.png`, { maxDiffPixelRatio: 0.01 });
    });
  });
}

test("Geist and Geist Mono are bundled, loaded, and used for the note, the chrome, code, and keycaps", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await openHarness(page, NOTE);
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("command-panel")).toBeVisible();
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const family = (selector: string) => getComputedStyle(document.querySelector(selector)!).fontFamily;
    // Each face loads from the bundle (an empty result would mean no @font-face matched).
    const loaded = async (font: string) => (await document.fonts.load(font)).some((face) => face.status === "loaded");
    return {
      sans: await loaded("15px Geist"),
      sansItalic: await loaded("italic 15px Geist"),
      mono: await loaded("13px 'Geist Mono'"),
      note: family(".note-editor p"),
      title: family("[data-testid=title]"),
      code: family(".note-editor .code-block pre"),
      chip: family(".note-editor p code"),
      keycap: family(".keycap"),
    };
  });
  expect(fonts.sans && fonts.sansItalic && fonts.mono).toBe(true);
  for (const key of ["note", "title"] as const) expect(fonts[key]).toMatch(/^"?Geist"?,/);
  for (const key of ["code", "chip", "keycap"] as const) expect(fonts[key]).toMatch(/^"?Geist Mono"?,/);
  // The faces come from the editor's own origin, never from a font service.
  const fontRequests = requests.filter((url) => url.includes(".woff2"));
  expect(fontRequests.length).toBeGreaterThan(0);
  for (const url of fontRequests) expect(new URL(url).origin).toBe(new URL(page.url()).origin);
});

/** Chrome sizing: the 28 point hit floor, the two part focus ring, and the high zoom layout. */
const FLOOR = 28;

async function setZoom(page: Page, zoom: number): Promise<void> {
  // The mock keeps the settings, so a later toggle does not write the old zoom back.
  const current = await page.evaluate((z) => {
    const store = (window as unknown as { __overnoteMock: { store: { settings: Record<string, unknown> } } })
      .__overnoteMock.store;
    store.settings = { ...store.settings, zoom: z };
    return store.settings;
  }, zoom);
  await emit(page, "settings.changed", current);
  await expect(page.locator("html")).toHaveAttribute("data-high-zoom", String(zoom >= 1.75));
  await expect
    .poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize)))
    .toBeCloseTo(14 * zoom, 1);
}

/** Every visible control inside the app: its size, and whether it overlaps another one. */
async function controls(page: Page) {
  return page.evaluate((floor) => {
    const app = document.querySelector("[data-testid=app]")!.getBoundingClientRect();
    const selector = "button, input, [role=switch], [role=menuitem], .panel-row, .menu-item, .emoji-cell";
    const items = [...document.querySelectorAll<HTMLElement>(selector)]
      .map((el) => {
        // A format button scrolled out of the bar is clipped, so only its visible part can overlap.
        const clip = el.closest(".format-bar")?.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const visible = !clip || (box.right > clip.left && box.left < clip.right);
        const cr = clip
          ? {
              left: Math.max(box.left, clip.left),
              right: Math.min(box.right, clip.right),
              top: box.top,
              bottom: box.bottom,
            }
          : box;
        return { el, r: box, cr, cs: getComputedStyle(el), visible };
      })
      .filter(({ visible }) => visible)
      .filter(({ r, cs }) => r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none");
    const label = (el: HTMLElement) => el.dataset.testid || el.className || el.tagName;
    const small = items
      .filter(({ r }) => r.width < floor - 0.5 || r.height < floor - 0.5)
      .map(({ el, r }) => `${label(el)} ${r.width.toFixed(1)}x${r.height.toFixed(1)}`);
    const overlaps: string[] = [];
    const buttons = items.filter(({ el }) => el.tagName === "BUTTON" && !el.closest(".panel-row"));
    for (let i = 0; i < buttons.length; i++) {
      for (let j = i + 1; j < buttons.length; j++) {
        const a = buttons[i]!.cr;
        const b = buttons[j]!.cr;
        if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) {
          overlaps.push(`${label(buttons[i]!.el)} / ${label(buttons[j]!.el)}`);
        }
      }
    }
    return { small, overlaps, app: { w: app.width, h: app.height }, count: items.length };
  }, FLOOR);
}

test.describe("chrome sizing", () => {
  for (const zoom of [0.75, 1, 2]) {
    test(`hit floor and layout at ${zoom * 100}% zoom`, async ({ page }) => {
      await openHarness(page, [NOTE[0]!, "second note\n\nwith a longer body"]);
      await setZoom(page, zoom);
      await page.keyboard.press("Alt+Meta+Comma");
      await expect(page.getByTestId("format-bar")).toBeVisible();

      // The toolbar, footer, and format bar.
      let found = await controls(page);
      expect(found.small, "controls under the floor").toEqual([]);
      expect(found.overlaps).toEqual([]);
      const footer = await page
        .getByTestId("footer")
        .evaluate((el) => el.closest(".app")!.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom);
      expect(footer).toBeGreaterThanOrEqual(-0.5);

      // The command panel, its search field, and rows.
      await page.keyboard.press("Meta+k");
      await expect(page.getByTestId("command-panel")).toBeVisible();
      await settle(page);
      found = await controls(page);
      expect(found.small, "panel controls under the floor").toEqual([]);
      const panel = await page.locator(".panel").evaluate((el) => {
        const r = el.getBoundingClientRect();
        const app = el.closest(".app")!.getBoundingClientRect();
        const rows = [...el.querySelectorAll<HTMLElement>(".panel-row, .menu-item")].map((row) =>
          row.getBoundingClientRect(),
        );
        return {
          width: r.width,
          height: r.height,
          inside: r.left >= app.left - 0.5 && r.right <= app.right + 0.5 && r.bottom <= app.bottom + 0.5,
          rowsInside: rows.every((row) => row.left >= r.left - 0.5 && row.right <= r.right + 0.5),
        };
      });
      // Measured at 200%: the panel is 638 x 454 points on upstream rules, inside the app, so the 24rem cap is not adopted.
      expect(panel.inside).toBe(true);
      expect(panel.rowsInside).toBe(true);
      await page.keyboard.press("Escape");

      // The find bar and the emoji picker are covered by the same control scan.
      await editor(page).focus();
      await page.keyboard.press("Meta+f");
      await expect(page.getByTestId("find-bar")).toBeVisible();
      await settle(page);
      found = await controls(page);
      expect(found.small, "find bar controls under the floor").toEqual([]);
      expect(found.overlaps).toEqual([]);
    });
  }

  test("200% zoom: the format bar scrolls without wrapping, the find bar docks full width, rows wrap", async ({
    page,
  }) => {
    await openHarness(page, ["a note with a deliberately long title that cannot fit one line at high zoom\n\nbody"]);
    await setZoom(page, 2);
    await page.keyboard.press("Alt+Meta+Comma");
    const formatBar = page.getByTestId("format-bar");
    await expect(formatBar).toBeVisible();
    // At its minimum size the whole bar fits; on a display narrower than that minimum it scrolls sideways.
    const minimumWidth = async () =>
      ((await calls(page, "window.setMinimumSize")).at(-1)?.params as { width: number }).width;
    const appWidth = () => page.getByTestId("app").evaluate((el) => el.getBoundingClientRect().width);
    await expect.poll(async () => (await appWidth()) - (await minimumWidth())).toBe(0);
    const scroller = () =>
      formatBar.evaluate((el) => {
        const tops = new Set([...el.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().top)));
        return {
          lines: tops.size,
          scrolls: el.scrollWidth > el.clientWidth,
          overflowX: getComputedStyle(el).overflowX,
        };
      });
    expect(await scroller()).toEqual({ lines: 1, scrolls: false, overflowX: "auto" });
    const fitted = await minimumWidth();
    await page.evaluate(() => (document.getElementById("root")!.style.width = "480px"));
    await expect.poll(scroller).toEqual({ lines: 1, scrolls: true, overflowX: "auto" });
    // The minimum is the bar's full width, not the narrower box it scrolls in.
    expect(await minimumWidth()).toBe(fitted);
    await page.evaluate((width) => (document.getElementById("root")!.style.width = `${width}px`), fitted);

    await editor(page).focus();
    await page.keyboard.press("Meta+f");
    await settle(page);
    const find = await page.getByTestId("find-bar").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const app = el.closest(".app")!.getBoundingClientRect();
      return { left: r.left - app.left, right: app.right - r.right };
    });
    expect(find).toEqual({ left: 0, right: 0 });
    await page.keyboard.press("Escape");

    await page.keyboard.press("Meta+p");
    const row = page.getByTestId("browse-row").first();
    await expect(row).toBeVisible();
    const clamp = await row.locator(".panel-row-title").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { whiteSpace: cs.whiteSpace, lines: cs.webkitLineClamp };
    });
    expect(clamp).toEqual({ whiteSpace: "normal", lines: "2" });
  });

  test("the focus ring is a gap then a ring on every kind of focusable control", async ({ page }) => {
    await openHarness(page, NOTE);
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("command-panel")).toBeVisible();
    // The outer (not inset) layers of a box-shadow, as their rgb triples: the gap first, then the ring.
    const rgb = (c: string) => (c.match(/\d+/g) ?? []).slice(0, 3).join(",");
    const outer = (shadow: string) =>
      shadow
        .split(/,\s*(?=rgba?\()/)
        .filter((layer) => layer.includes("rgb") && !layer.includes("inset"))
        .map((layer) => rgb(layer.slice(layer.indexOf("rgb"))));
    const gap = await token(page, "--bg-raised");
    const color = await token(page, "--focus-ring");
    const active = () =>
      page.evaluate(() => {
        const el = document.activeElement!;
        return { cls: el.className || el.tagName, shadow: getComputedStyle(el).boxShadow };
      });
    const expectRing = async (what: string) =>
      expect.poll(async () => outer((await active()).shadow), { message: what }).toEqual([rgb(gap), rgb(color)]);
    await expectRing("panel search");
    // Rows, toolbar buttons, and menu items take focus by script after a key press, as a Tab would.
    for (const selector of [".panel-row", "[data-testid=new-note]"]) {
      await page
        .locator(selector)
        .first()
        .evaluate((el) => (el as HTMLElement).focus());
      await page.keyboard.press("Shift");
      await expectRing(selector);
    }
    await openHarness(page, NOTE);
    await page.keyboard.press("Alt+Meta+Comma");
    await expect(page.getByTestId("format-bar")).toBeVisible();
    await page
      .locator("[data-testid=format-bar] button")
      .first()
      .evaluate((el) => (el as HTMLElement).focus());
    await page.keyboard.press("Shift");
    await expectRing("format button");
  });
});

for (const scheme of ["light", "dark"] as const) {
  test(`empty note hints, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openHarness(page);
    await page.mouse.move(5, 5);
    await expect(page.getByTestId("empty-hints")).toBeVisible();
    await expect(page.locator(".content")).toHaveScreenshot(`empty-hints-${scheme}.png`, { maxDiffPixelRatio: 0.01 });
  });
}
