import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The build smoke test builds and serves the editor from a temp folder, never assets/editor: a
// running helper started with --watch-editor reloads its panel whenever assets/editor changes.
// Workers inherit the variable, so they agree with the web servers on the folder.
process.env.OVERNOTE_EDITOR_OUT_DIR ||= path.join(os.tmpdir(), "overnote-editor-e2e");

/**
 * End-to-end flows against the real editor UI. The dev server serves the editor with the in-memory
 * mock bridge (src/dev/mockBridge.ts); the build smoke test serves a fresh production build with a tiny
 * stub, written to OVERNOTE_EDITOR_OUT_DIR.
 */
export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  // GitHub's macOS runners have 3 cores; Playwright's default (half of them) would run one worker.
  workers: process.env.CI ? 3 : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // CI also writes an HTML report, uploaded when the job fails.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    trace: "retain-on-failure",
  },
  // WebKit is the engine of the native WKWebView panel, the only place the editor runs.
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 640, height: 720 } } }],
  webServer: [
    {
      command: "npx vite --host 127.0.0.1 --port 5199 --strictPort",
      url: "http://127.0.0.1:5199",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "npx vite build && npx vite preview --host 127.0.0.1 --port 5198 --strictPort",
      url: "http://127.0.0.1:5198",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
