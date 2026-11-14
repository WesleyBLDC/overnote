/**
 * Entry point. The bridge is installed before anything is sent (docs/architecture.md section 3).
 * In the dev server, a mock native side is installed when no WKWebView handler exists.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApi } from "./bridge/api";
import { hasNativeBridge, installBridge, type BridgeWindow } from "./bridge/client";
import { watchScrollbarStyle } from "./lib/scrollbars";
import { App } from "./ui/App";
import "./styles/theme.css";
import "./styles/app.css";
import "./styles/editor.css";

/**
 * Loads the bundled faces before the first render, so the note is measured and painted in Geist from the
 * start and the window never resizes when a font arrives. They come from local disk in a few milliseconds;
 * the timeout only guards against a font that never loads.
 */
async function loadFonts(): Promise<void> {
  const faces = ["400 1em Geist", "600 1em Geist", "400 1em 'Geist Mono'"].map((font) => document.fonts.load(font));
  await Promise.race([Promise.allSettled(faces), new Promise((resolve) => setTimeout(resolve, 500))]);
}

async function start(): Promise<void> {
  const host = window as unknown as BridgeWindow;
  const client = installBridge(host);
  if (import.meta.env.DEV && !hasNativeBridge(host)) {
    const { installMockBridge } = await import("./dev/mockBridge");
    installMockBridge(window);
  }
  watchScrollbarStyle(window);
  await loadFonts();
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root");
  createRoot(root).render(
    <StrictMode>
      <App api={createApi(client)} />
    </StrictMode>,
  );
}

void start();
