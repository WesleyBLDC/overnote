import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The command end-to-end tests run the real commands; only Raycast's UI calls are stubbed.
    alias: {
      "@raycast/api": fileURLToPath(new URL("./src/__mocks__/raycast-api.ts", import.meta.url)),
      "@raycast/utils": fileURLToPath(new URL("./src/__mocks__/raycast-utils.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 15000,
    // A helper started by a test never writes into the real backups folder.
    // TZ: a zone with daylight saving, so the Search Notes sections test covers a 23 hour day.
    env: {
      OVERNOTE_BACKUP_DIR: path.join(os.tmpdir(), `overnote-vitest-backups-${process.pid}`),
      TZ: "America/Los_Angeles",
    },
  },
});
