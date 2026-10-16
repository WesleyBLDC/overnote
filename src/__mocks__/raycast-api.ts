/**
 * A stand-in for @raycast/api in the command end-to-end tests (vitest alias): the commands and
 * src/api run for real against a real helper, and only Raycast's own UI calls are recorded here.
 */
export const environment = {
  supportPath: "",
  assetsPath: "",
  isDevelopment: false,
};

/** Everything the commands asked Raycast to show, in order. */
export const shown: string[] = [];

export async function closeMainWindow(): Promise<void> {}

export async function showHUD(title: string): Promise<void> {
  shown.push(`hud: ${title}`);
}

export async function showToast(options: { title: string }): Promise<void> {
  shown.push(`toast: ${options.title}`);
}

export const Toast = { Style: { Success: "success", Failure: "failure", Animated: "animated" } };

/** No app has a selection to read. */
export async function getSelectedText(): Promise<string> {
  throw new Error("Unable to get selected text");
}

export enum LaunchType {
  UserInitiated = "userInitiated",
  Background = "background",
}

/** The menu bar command is not enabled, as for most people; refreshMenuBar ignores this. */
export async function launchCommand(): Promise<void> {
  throw new Error("Command is not enabled");
}

export const Clipboard = { copy: async (text: string) => void shown.push(`clipboard: ${text}`) };

export async function showInFinder(): Promise<void> {}
