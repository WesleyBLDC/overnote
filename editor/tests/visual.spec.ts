/** Theme and contrast: the iris violet accent, code blocks, and task states, in both color schemes. */
import { expect, test, type Page } from "@playwright/test";
import { editor, openHarness } from "./harness";

const NOTE = [
  "Hello\n\n1. one\n\n- [x] done [link](https://example.com) and `code`\n\n- [ ] todo\n\n[link](https://example.com)\n\n```js\n// a comment\nconst a = 1;\n```",
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

const SCHEMES = {
  light: { accent: "rgb(91, 75, 213)", strong: "rgb(71, 56, 176)", selection: "rgba(91, 75, 213, 0.16)" },
  dark: { accent: "rgb(143, 128, 255)", strong: "rgb(184, 174, 255)", selection: "rgba(143, 128, 255, 0.24)" },
} as const;

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openHarness(page, NOTE);
    });

    test("accent: links, ordered numbers, and the selection carry the iris violet", async ({ page }) => {
      const want = SCHEMES[scheme];
      expect(await token(page, "--accent")).toBe(want.accent);
      expect(await token(page, "--accent-strong")).toBe(want.strong);
      expect(await token(page, "--selection", "background-color")).toBe(want.selection);
      expect(await style(page, ".note-editor > p a, .note-editor > .prosemirror-flat-list ~ p a", "color")).toBe(
        want.strong,
      );
      expect(await style(page, ".note-editor [data-list-kind=ordered]", "color", "::before")).toBe(want.accent);
      const underline = await style(page, ".note-editor p a", "text-decoration-color");
      expect(underline).not.toBe(want.strong);
      expect(await style(page, ".note-editor p a", "text-decoration-line")).toContain("underline");
    });

    test("code and tasks: essential strength text, raised surfaces, ring", async ({ page }) => {
      const essential = await token(page, "--text-essential");
      expect(essential).toBe(scheme === "light" ? "rgba(12, 12, 14, 0.62)" : "rgba(255, 255, 255, 0.68)");
      const surface = await token(page, "--surface-code", "background-color");
      expect(surface).toBe(scheme === "light" ? "rgba(12, 12, 14, 0.07)" : "rgba(255, 255, 255, 0.09)");
      expect(await style(page, ".note-editor .code-block", "background-color")).toBe(surface);
      expect(await style(page, ".note-editor .code-block", "box-shadow")).toContain("inset");
      expect(await token(page, "--code-comment")).toBe(essential);

      const checked = ".note-editor [data-list-kind=task][data-list-checked] > .list-content > p";
      expect(await style(page, checked, "color")).toBe(essential);
      expect(await style(page, checked, "opacity")).toBe("1");
      expect(await style(page, `${checked} a`, "color")).toBe(essential);
      expect(await style(page, `${checked} code`, "opacity")).toBe("1");
      expect(await style(page, ".note-editor .hljs-comment", "color")).toBe(essential);
    });

    test("normal state: placeholder at essential strength, snapshot", async ({ page }) => {
      await openHarness(page);
      expect(await style(page, ".note-editor .is-empty", "color", "::before")).toBe(
        await token(page, "--text-essential"),
      );
      await openHarness(page, NOTE);
      await page.mouse.move(5, 5);
      await expect(editor(page)).toHaveScreenshot(`note-${scheme}.png`, { maxDiffPixelRatio: 0.01 });
    });
  });
}
