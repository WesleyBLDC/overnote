#!/usr/bin/env node
/**
 * Regenerates README product shots in media/ from the editor browser harness.
 *
 * Why in-repo Playwright (not Shotcraft / Just-Product-Preview / auto_demo):
 * those tools are young or SaaS-shaped; Overnote already has WebKit Playwright
 * and a Store shot script. This keeps captures deterministic, 2x Retina, and
 * free of new dependencies.
 *
 * Prerequisites:
 *   npm install
 *   npx playwright install webkit   # once
 *   npm run dev -w editor -- --port 5299 --strictPort --host 127.0.0.1
 *
 * Usage:
 *   node scripts/readme-shots.mjs [base url]
 *
 * Default base: http://127.0.0.1:5299
 * Run against origin/main UI (or a worktree at the commit you are documenting).
 *
 * Refresh when any of these change: accent, toolbar chrome, ⌘K row icons,
 * window placement actions, Browse section badges, hero note content, or
 * panel geometry that README alt text describes.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { webkit } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2] ?? "http://127.0.0.1:5299";
const OUT = path.join(ROOT, "media");
const SCALE = 2;
const PANEL = { width: 512, height: 448 };
const PAD = 56;
const VIEW = { width: PANEL.width + PAD * 2, height: PANEL.height + PAD * 2 };

const SHOWCASE = `# Weekend project

Build a tiny **CLI** that turns a folder of \`.md\` files into a static site.

1. Sketch the commands
2. Parse front matter

- [x] Sketch the commands
- [x] Parse front matter
- [ ] Write the *render* step

Visit the [docs](https://example.com) when stuck.

\`\`\`js
export function slug(title) {
  return title.toLowerCase().replace(/\\s+/g, "-");
}
\`\`\`
`;

const NOTES = [
  "Trip ideas\n\nLisbon in spring, the coast road to Porto, and a night train north.",
  "Meeting notes\n\nShip the beta on Friday. Ask design for the empty states.",
  "Reading list\n\n- The Design of Everyday Things\n- A Pattern Language\n- Shape Up",
  "Groceries\n\n- [ ] Oat milk\n- [ ] Lemons\n- [ ] Fresh basil\n- [x] Coffee beans",
  "Gift ideas\n\nA good chef's knife, a film camera, concert tickets.",
  "Book club\n\nNext pick: The Left Hand of Darkness. Meet on the 14th.",
  SHOWCASE,
];

const STAGE_CSS = `
  html[data-harness], html[data-harness] body {
    width: 100%; height: 100%; overflow: hidden !important;
  }
  html[data-harness] body {
    display: flex; align-items: center; justify-content: center;
    background: transparent !important;
  }
  html[data-harness] { background: #151a21 !important; }
  html[data-harness] body::before {
    content: ""; position: fixed; inset: -24px; z-index: -1;
    background:
      radial-gradient(90% 110% at 18% 8%, #3d5163 0%, rgba(61, 81, 99, 0) 62%),
      radial-gradient(80% 90% at 88% 96%, #2f3b52 0%, rgba(47, 59, 82, 0) 60%),
      linear-gradient(160deg, #222c36 0%, #151a21 100%);
  }
  html[data-harness][data-scheme=light] { background: #e8e6e1 !important; }
  html[data-harness][data-scheme=light] body::before {
    background:
      radial-gradient(90% 110% at 18% 8%, #d9d4c8 0%, rgba(217, 212, 200, 0) 62%),
      radial-gradient(80% 90% at 88% 96%, #cfc8ba 0%, rgba(207, 200, 186, 0) 60%),
      linear-gradient(160deg, #f3f1ec 0%, #e8e6e1 100%);
  }
  html[data-harness] #root {
    flex: none; margin: 0 !important;
    width: ${PANEL.width}px; max-width: none !important;
    height: ${PANEL.height}px !important;
    box-shadow: 0 28px 72px rgba(0, 0, 0, 0.42), 0 8px 20px rgba(0, 0, 0, 0.28), 0 0 0 0.5px rgba(255, 255, 255, 0.12) !important;
  }
  html[data-harness][data-scheme=light] #root {
    box-shadow: 0 28px 72px rgba(40, 36, 28, 0.18), 0 8px 20px rgba(40, 36, 28, 0.1), 0 0 0 0.5px rgba(0, 0, 0, 0.06) !important;
  }
`;

const browser = await webkit.launch();

async function shot(name, prepare, { scheme = "dark" } = {}) {
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: SCALE,
    colorScheme: scheme,
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/?seed=${encodeURIComponent(JSON.stringify(NOTES))}`);
  await page.waitForSelector("[data-testid=app][data-ready=true]");
  await page.evaluate((s) => document.documentElement.setAttribute("data-scheme", s), scheme);
  await page.addStyleTag({ content: STAGE_CSS });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((titles) => {
    const mock = window.__overnoteMock;
    for (const title of titles) {
      const note = [...mock.store.notes.values()].find((n) => n.title === title);
      if (note) mock.store.dispatch("notes.pin", { id: note.id });
    }
  }, ["Groceries", "Reading list"]);
  await page.evaluate(() => {
    const mock = window.__overnoteMock;
    const minute = 60 * 1000;
    const ago = {
      "Weekend project": 0,
      Groceries: 25,
      "Reading list": 60 * 26,
      "Book club": 180,
      "Meeting notes": 60 * 5,
      "Gift ideas": 60 * 24 * 3,
      "Trip ideas": 60 * 24 * 9,
    };
    const now = Date.now();
    for (const note of mock.store.notes.values()) {
      const minutes = ago[note.title];
      if (minutes === undefined) continue;
      note.lastAccessedAt = now - minutes * minute;
      note.updatedAt = Math.min(note.updatedAt, note.lastAccessedAt);
    }
  });
  // Seed leaves the last note current; make sure it is the showcase.
  await page.evaluate(() => {
    const mock = window.__overnoteMock;
    const note = [...mock.store.notes.values()].find((n) => n.title === "Weekend project");
    if (note) mock.store.dispatch("notes.setCurrentNote", { noteId: note.id });
  });
  await page.waitForTimeout(200);
  await page.locator(".note-editor").focus();
  const box = await page.locator("#root").boundingBox();
  await page.mouse.move(box.x + box.width * 0.88, box.y + box.height * 0.82);
  if (prepare) await prepare(page, box);
  await page.waitForTimeout(600);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, ...VIEW }, animations: "disabled" });
  await context.close();
  console.log("wrote", file);
}

await shot("note-dark");
await shot("note-light", null, { scheme: "light" });

await shot("actions-dark", async (page) => {
  await page.keyboard.press("Meta+k");
  await page.getByTestId("command-panel").waitFor();
  // Bring window placements into view so icons and Fill actions show in the README shot.
  const fill = page.getByTestId("action-fillLeft");
  await fill.waitFor({ state: "attached" });
  await fill.evaluate((el) => {
    const list = el.closest(".panel-list");
    if (list) el.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(200);
});

await shot("browse-dark", async (page) => {
  await page.keyboard.press("Meta+p");
  await page.waitForSelector("[data-testid=browse-row]");
});

await browser.close();

const files = ["note-dark", "note-light", "actions-dark", "browse-dark"].map((n) => path.join(OUT, `${n}.png`));
const optimizer = path.join(ROOT, "scripts/readme-png-opt.py");
console.log(execFileSync("python3", ["-I", optimizer, ...files], { encoding: "utf8" }));
