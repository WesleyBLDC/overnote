import { LaunchType, launchCommand } from "@raycast/api";

/**
 * Asks the menu bar command to reload right away (pomodoro pattern). The menu bar is disabled by
 * default, and launchCommand throws when it is, so failures are ignored on purpose.
 */
export async function refreshMenuBar(): Promise<void> {
  try {
    await launchCommand({ name: "menu-bar", type: LaunchType.Background });
  } catch {
    // The menu bar command is not enabled.
  }
}
