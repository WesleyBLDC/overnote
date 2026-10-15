import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end flows against the real editor UI. The dev server serves the editor with the in-memory
 * mock bridge (src/dev/mockBridge.ts); the build smoke test serves assets/editor with a tiny stub.
 */
export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:5199",
    trace: "retain-on-failure",
  },
  // WebKit is the engine of the native WKWebView panel, so every flow runs there.
  // Chromium only runs the build smoke test, as a second engine check of the shipped bundle.
  projects: [
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 640, height: 720 } } },
    { name: "chromium", testMatch: /build\.spec\.ts/, use: { ...devices["Desktop Chrome"], viewport: { width: 640, height: 720 } } },
  ],
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
