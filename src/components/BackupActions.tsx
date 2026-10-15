import { Action, ActionPanel, Icon, Toast, showToast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";

import { backUpNow, revealBackupsFolder } from "../api/backups";
import { RestoreBackupList } from "./RestoreBackupList";

/** Back Up Notes Now, Restore Notes from Backup, and Reveal Backups Folder, for any action panel. */
export function BackupActionsSection({ onRestored }: { onRestored?: () => Promise<unknown> | void }) {
  async function backUp() {
    try {
      const toast = await showToast({ style: Toast.Style.Animated, title: "Backing Up Notes" });
      const backup = await backUpNow();
      toast.style = Toast.Style.Success;
      toast.title = "Backed Up Notes";
      toast.message = backup.name;
    } catch (error) {
      await showFailureToast(error, { title: "Could not back up the notes" });
    }
  }

  async function reveal() {
    try {
      await revealBackupsFolder();
    } catch (error) {
      await showFailureToast(error, { title: "Could not open the backups folder" });
    }
  }

  return (
    <ActionPanel.Section title="Backups">
      <Action
        // "Back Up" is the verb; the title-case rule would lowercase "Up" as a preposition.
        // eslint-disable-next-line @raycast/prefer-title-case
        title="Back Up Notes Now"
        icon={Icon.SaveDocument}
        onAction={backUp}
      />
      <Action.Push
        title="Restore Notes from Backup"
        icon={Icon.ArrowCounterClockwise}
        target={<RestoreBackupList onRestored={onRestored} />}
      />
      <Action title="Reveal Backups Folder" icon={Icon.Finder} onAction={reveal} />
    </ActionPanel.Section>
  );
}
