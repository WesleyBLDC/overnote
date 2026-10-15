import { beforeEach, describe, expect, it, vi } from "vitest";

import { closeMainWindow, showHUD } from "@raycast/api";

const call = vi.fn(async (method: string) => (method === "window.toggle" ? { visible: true } : { visible: true }));
const ensureHelper = vi.fn(async (options?: { show?: boolean }) => ({
  client: { call },
  version: "1.0.0",
  pid: 1,
  started: options?.show === true && startedNext,
}));
let startedNext = false;

vi.mock("../api/helper", () => ({ ensureHelper }));

async function runCommand(props: object) {
  const { default: command } = await import("../toggle-notes");
  await command(props as Parameters<typeof command>[0]);
}

describe("toggle-notes command", () => {
  beforeEach(() => {
    call.mockClear();
    ensureHelper.mockClear();
    vi.mocked(showHUD).mockClear();
    vi.mocked(closeMainWindow).mockClear();
    startedNext = false;
  });

  it("toggles a running helper", async () => {
    await runCommand({ arguments: {} });
    expect(closeMainWindow).toHaveBeenCalled();
    expect(ensureHelper).toHaveBeenCalledWith({ show: true });
    expect(call).toHaveBeenCalledWith("window.toggle", {});
    expect(showHUD).not.toHaveBeenCalled();
  });

  it("does not toggle a helper it just started with --show", async () => {
    startedNext = true;
    await runCommand({ arguments: {} });
    expect(call).not.toHaveBeenCalled();
  });

  it("opens the note named by the launch context", async () => {
    await runCommand({ arguments: {}, launchContext: { id: "01ABC" } });
    expect(call).toHaveBeenCalledWith("window.show", { noteId: "01ABC" });
    expect(call).not.toHaveBeenCalledWith("window.toggle", {});
  });

  it("shows a HUD only when something fails", async () => {
    ensureHelper.mockRejectedValueOnce(new Error("The Better Notes helper is not built."));
    await runCommand({ arguments: {} });
    expect(showHUD).toHaveBeenCalledWith("Better Notes: The Better Notes helper is not built.");
  });
});
