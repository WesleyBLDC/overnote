import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const OUT_DIR = fileURLToPath(new URL("../assets/editor", import.meta.url));

/**
 * Production HTML for the WKWebView: a strict CSP, and no crossorigin attributes,
 * because assets come from the betternotes:// custom scheme on the same origin.
 */
function nativeHtml(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "better-notes-native-html",
    apply: "build",
    transformIndexHtml(html) {
      return html
        .replace(/\s+crossorigin(="[^"]*")?/g, "")
        .replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), nativeHtml()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    target: "safari16",
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    reportCompressedSize: true,
    // The bundle loads from local disk inside the panel; grammars and emoji data are split out lazily.
    chunkSizeWarningLimit: 1000,
  },
  server: { port: 5199, strictPort: true },
  preview: { port: 5198, strictPort: true },
});
