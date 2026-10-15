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
      await showHUD(`Overnote runs from source (${installed.version}); the latest release is ${latest.version}`);
      return;
    }
    if (compareVersions(latest.version, installed.version) <= 0) {
      await showHUD(`Overnote ${installed.version} is up to date`);
      return;
    }
    await Clipboard.copy(updateCommand(installed.installDir));
    await showHUD(`Overnote ${latest.version} is available. Copied the update command; paste it into Terminal`);
  } catch (error) {
    await showFailureToast(error, { title: "Could not check for updates" });
  }
}
