const { defineConfig, globalIgnores } = require("eslint/config");
const raycastConfig = require("@raycast/eslint-config");
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const reactHooks = require("eslint-plugin-react-hooks");
const prettier = require("eslint-config-prettier/flat");
const globals = require("globals");

// The extension (src/) keeps Raycast's config exactly as `ray lint` runs it (`eslint src/**`).
// The editor and @overnote/core get their own blocks: typescript-eslint everywhere, plus the
// React hooks rules and browser globals for the editor's code.
const EDITOR_AND_CORE = ["editor/**/*.{ts,tsx}", "packages/core/**/*.ts"];

module.exports = defineConfig([
  globalIgnores([
    "dist/**",
    "assets/**",
    "helper/**",
    "raycast-env.d.ts",
    "**/node_modules/**",
    "editor/test-results/**",
    "editor/playwright-report/**",
  ]),
  {
    ignores: EDITOR_AND_CORE,
    extends: [raycastConfig],
  },
  {
    files: EDITOR_AND_CORE,
    extends: [js.configs.recommended, tseslint.configs.recommended, prettier],
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["editor/src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
    rules: {
      // Tiptap's focus command focuses again a frame later and can steal focus from a panel opened
      // in between (⌘K right after a format bar click); focusEditorNow focuses at once.
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='focus'][callee.object.property.name='commands']",
          message: "Use focusEditorNow(editor) from editor/commands: Tiptap's focus command refocuses a frame later.",
        },
        {
          selector: "CallExpression[callee.property.name='focus'][callee.object.callee.property.name='chain']",
          message: "Call focusEditorNow(editor) before the chain: Tiptap's focus command refocuses a frame later.",
        },
      ],
    },
  },
  {
    files: ["editor/tests/**/*.ts", "editor/unit/**/*.ts", "editor/*.config.ts", "packages/core/**/*.ts"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]);
