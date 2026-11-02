import { Clipboard, Toast, environment, showHUD, showToast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";

import { getLauncher } from "./api/helper";
import { compareVersions, fetchLatestRelease, readInstalledVersion, updateCommand } from "./domain/updates";

/**
 * Compares the installed version with the latest GitHub release. When a newer one exists, it
 * copies the update command to the clipboard; it never runs anything itself.
 */
export default async function CheckForUpdates() {
  try {
    await showToast({ style: Toast.Style.Animated, title: "Checking for Updates" });
    const installed = await readInstalledVersion(environment.assetsPath, () => getLauncher().expectedVersion());
    const latest = await fetchLatestRelease();
    if (installed.source === "source") {
      await showHUD(
        `Overnote ${installed.version} is a source build with no release metadata. Latest release is ${latest.version}. No update command was copied.`,
      );
      return;
    }
    if (compareVersions(latest.version, installed.version) <= 0) {
      await showHUD(`Overnote ${installed.version} is up to date. Latest release is ${latest.version}.`);
      return;
    }
    await Clipboard.copy(updateCommand(installed.installDir));
    await showHUD(
      `Overnote ${latest.version} is available. You have ${installed.version}. Copied the update command to the clipboard. Paste it into Terminal to update.`,
    );
  } catch (error) {
    await showFailureToast(error, { title: "Could not check for updates" });
  }
}
