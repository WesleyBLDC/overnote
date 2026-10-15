/**
 * A small stand-in for @raycast/api, wired in through the vitest alias (obsidian pattern).
 * Only what the tested modules touch is provided.
 */
import { vi } from "vitest";

export const environment = {
  supportPath: "/tmp/overnote-test-support",
  assetsPath: "/tmp/overnote-test-assets",
  launchType: "userInitiated",
};

export enum LaunchType {
  UserInitiated = "userInitiated",
  Background = "background",
}

export const launchCommand = vi.fn(async () => undefined);
export const closeMainWindow = vi.fn(async () => undefined);
export const showHUD = vi.fn(async () => undefined);
export const showToast = vi.fn(async () => ({ hide: async () => undefined }));
export const getSelectedText = vi.fn(async (): Promise<string> => {
  throw new Error("No selected text");
});

export const Toast = { Style: { Success: "success", Failure: "failure", Animated: "animated" } };
