import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 15000,
    // A helper started by a test never writes into the real backups folder.
    env: { OVERNOTE_BACKUP_DIR: path.join(os.tmpdir(), `overnote-vitest-backups-${process.pid}`) },
  },
  resolve: {
    alias: {
      "@raycast/api": fileURLToPath(new URL("./src/__mocks__/raycast-api.ts", import.meta.url)),
    },
  },
});
