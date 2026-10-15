import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  List,
  Toast,
  confirmAlert,
  showToast,
  useNavigation,
} from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";

import { backUpNow, listBackups, restoreBackup, revealBackupsFolder } from "../api/backups";
import { backupDate, backupReasonLabel, formatBytes } from "../domain/format";
import type { BackupInfo } from "../domain/types";

export interface RestoreBackupListProps {
  /** Called after a restore, so the caller can reload its notes. */
  onRestored?: () => Promise<unknown> | void;
}

/** Every backup, newest first; restoring one asks for confirmation and backs up the current notes first. */
export function RestoreBackupList({ onRestored }: RestoreBackupListProps) {
  const { pop } = useNavigation();
  const { data: backups = [], isLoading, revalidate } = useCachedPromise(listBackups, [], { keepPreviousData: true });

  async function restore(backup: BackupInfo) {
    try {
      const confirmed = await confirmAlert({
        title: "Restore Notes from Backup?",
        message: `Every note is replaced by the notes from ${backupDate(backup.createdAt)}. Your current notes are backed up first, so this can be undone by restoring that backup.`,
        icon: { source: Icon.ArrowCounterClockwise, tintColor: Color.Orange },
        primaryAction: { title: "Restore", style: Alert.ActionStyle.Destructive },
      });
      if (!confirmed) return;
      const toast = await showToast({ style: Toast.Style.Animated, title: "Restoring Notes" });
      const result = await restoreBackup(backup.path);
      toast.style = Toast.Style.Success;
      toast.title = "Restored Notes";
      toast.message = `${result.noteCount === 1 ? "1 note" : `${result.noteCount} notes`} from ${backupDate(backup.createdAt)}`;
      await onRestored?.();
      pop();
    } catch (error) {
      await showFailureToast(error, { title: "Could not restore the backup" });
    }
  }

  async function backUp() {
    try {
      const backup = await backUpNow();
      await revalidate();
      await showToast({ style: Toast.Style.Success, title: "Backed Up Notes", message: backup.name });
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
    <List isLoading={isLoading} navigationTitle="Restore Notes from Backup" searchBarPlaceholder="Filter backups">
      <List.EmptyView
        icon={Icon.HardDrive}
        title="No Backups"
        description="Overnote backs up your notes every day, and before every update and restore."
        actions={
          <ActionPanel>
            <Action
              // "Back Up" is the verb; the title-case rule would lowercase "Up" as a preposition.
              // eslint-disable-next-line @raycast/prefer-title-case
              title="Back Up Notes Now"
              icon={Icon.SaveDocument}
              onAction={backUp}
            />
            <Action title="Reveal Backups Folder" icon={Icon.Finder} onAction={reveal} />
          </ActionPanel>
        }
      />
      {backups.map((backup) => (
        <List.Item
          key={backup.path}
          icon={Icon.HardDrive}
          title={backupDate(backup.createdAt)}
          subtitle={backupReasonLabel(backup.reason)}
          keywords={[backup.reason, backup.version]}
          accessories={[{ text: `v${backup.version}` }, { text: formatBytes(backup.sizeBytes) }]}
          actions={
            <ActionPanel>
              <Action title="Restore This Backup" icon={Icon.ArrowCounterClockwise} onAction={() => restore(backup)} />
              <Action.ShowInFinder path={backup.path} />
              <Action
                // "Back Up" is the verb; the title-case rule would lowercase "Up" as a preposition.
                // eslint-disable-next-line @raycast/prefer-title-case
                title="Back Up Notes Now"
                icon={Icon.SaveDocument}
                onAction={backUp}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
