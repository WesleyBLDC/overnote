import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      "@raycast/api": fileURLToPath(new URL("./src/__mocks__/raycast-api.ts", import.meta.url)),
    },
  },
});
