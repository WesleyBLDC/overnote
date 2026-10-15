/**
 * Entry point. The bridge is installed before anything is sent (docs/architecture.md section 3).
 * In the dev server, a mock native side is installed when no WKWebView handler exists.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createApi } from "./bridge/api";
import { hasNativeBridge, installBridge, type BridgeWindow } from "./bridge/client";
import { App } from "./ui/App";
import "./styles/theme.css";
import "./styles/app.css";
import "./styles/editor.css";

async function start(): Promise<void> {
  const host = window as unknown as BridgeWindow;
  const client = installBridge(host);
  if (import.meta.env.DEV && !hasNativeBridge(host)) {
    const { installMockBridge } = await import("./dev/mockBridge");
    installMockBridge(window);
  }
  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root");
  createRoot(root).render(
    <StrictMode>
      <App api={createApi(client)} />
    </StrictMode>,
  );
}

void start();
