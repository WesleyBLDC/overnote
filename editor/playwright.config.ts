import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { HARNESS_ORIGIN, HARNESS_PORT, PREVIEW_ORIGIN, PREVIEW_PORT } from "./tests/ports";

// The build smoke test builds and serves the editor from a temp folder, never assets/editor: a
// running helper started with --watch-editor reloads its panel whenever assets/editor changes.
// Workers inherit the variable, so they agree with the web servers on the folder.
process.env.OVERNOTE_EDITOR_OUT_DIR ||= path.join(os.tmpdir(), "overnote-editor-e2e");

/**
 * End-to-end flows against the real editor UI. The dev server serves the editor with the in-memory
 * mock bridge (src/dev/mockBridge.ts); the build smoke test serves a fresh production build with a tiny
 * stub, written to OVERNOTE_EDITOR_OUT_DIR.
 * Both servers always start fresh (reuseExistingServer is false) on the ports from tests/ports.ts,
 * so a run never tests a server another worktree started, and a busy port fails loudly.
 */
export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  // CI=true (if a runner ever sets it) uses 3 workers; locally Playwright picks its default.
  workers: process.env.CI ? 3 : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // CI=true also writes an HTML report.
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: HARNESS_ORIGIN,
    trace: "retain-on-failure",
  },
  // WebKit is the engine of the native WKWebView panel, the only place the editor runs.
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 640, height: 720 } } }],
  webServer: [
    {
      command: `npx vite --host 127.0.0.1 --port ${HARNESS_PORT} --strictPort`,
      url: HARNESS_ORIGIN,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite build && npx vite preview --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
      url: PREVIEW_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
