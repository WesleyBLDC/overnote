import { Action, Icon, Toast, showToast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";

import { backUpNow, revealBackupsFolder } from "../api/backups";
import type { BackupInfo } from "../domain/types";

/** Writes a backup now, with a progress toast that turns into the result. */
export async function backUpWithToast(): Promise<BackupInfo | undefined> {
  const toast = await showToast({ style: Toast.Style.Animated, title: "Backing Up Notes" });
  try {
    const backup = await backUpNow();
    toast.style = Toast.Style.Success;
    toast.title = "Backed Up Notes";
    toast.message = backup.name;
    return backup;
  } catch (error) {
    await toast.hide();
    await showFailureToast(error, { title: "Could not back up the notes" });
    return undefined;
  }
}

export async function revealBackupsWithToast(): Promise<void> {
  try {
    await revealBackupsFolder();
  } catch (error) {
    await showFailureToast(error, { title: "Could not open the backups folder" });
  }
}

/** The Back Up Notes Now action. */
export function BackUpNowAction({ onBackedUp }: { onBackedUp?: () => Promise<unknown> | void }) {
  return (
    <Action
      // "Back Up" is the verb; the title-case rule would lowercase "Up" as a preposition.
      // eslint-disable-next-line @raycast/prefer-title-case
      title="Back Up Notes Now"
      icon={Icon.SaveDocument}
      onAction={async () => {
        if (await backUpWithToast()) await onBackedUp?.();
      }}
    />
  );
}

export function RevealBackupsAction() {
  return <Action title="Reveal Backups Folder" icon={Icon.Finder} onAction={revealBackupsWithToast} />;
}
