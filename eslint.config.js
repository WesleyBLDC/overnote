const { defineConfig, globalIgnores } = require("eslint/config");
const raycastConfig = require("@raycast/eslint-config");

module.exports = defineConfig([
  globalIgnores(["dist/**", "assets/**", "editor/**", "packages/**", "helper/**", "raycast-env.d.ts"]),
  ...raycastConfig,
]);
