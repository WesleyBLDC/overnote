import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 15000,
    // A helper started by a test never writes into the real backups folder.
    env: { OVERNOTE_BACKUP_DIR: path.join(os.tmpdir(), `overnote-vitest-backups-${process.pid}`) },
  },
});
