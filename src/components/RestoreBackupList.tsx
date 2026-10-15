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

import { listBackups, restoreBackup } from "../api/backups";
import { backupDate, backupReasonLabel, formatBytes } from "../domain/format";
import type { BackupInfo } from "../domain/types";
import { BackUpNowAction, RevealBackupsAction } from "./BackupBasicActions";

export interface RestoreBackupListProps {
  /** Called after a restore, so the caller can reload its notes. */
  onRestored?: () => Promise<unknown> | void;
  /** True when this list is the command's root view (the menu bar's restore item), not a pushed one. */
  isRoot?: boolean;
}

/** Every backup, newest first; restoring one asks for confirmation and backs up the current notes first. */
export function RestoreBackupList({ onRestored, isRoot }: RestoreBackupListProps) {
  const { pop } = useNavigation();
  const { data: backups = [], isLoading, revalidate } = useCachedPromise(listBackups, [], { keepPreviousData: true });

  async function restore(backup: BackupInfo) {
    const confirmed = await confirmAlert({
      title: "Restore Notes from Backup?",
      message: `Every note is replaced by the notes from ${backupDate(backup.createdAt)}. Your current notes are backed up first, so this can be undone by restoring that backup.`,
      icon: { source: Icon.ArrowCounterClockwise, tintColor: Color.Orange },
      primaryAction: { title: "Restore", style: Alert.ActionStyle.Destructive },
    });
    if (!confirmed) return;
    const toast = await showToast({ style: Toast.Style.Animated, title: "Restoring Notes" });
    try {
      const result = await restoreBackup(backup.path);
      toast.style = Toast.Style.Success;
      toast.title = "Restored Notes";
      toast.message = `${result.noteCount === 1 ? "1 note" : `${result.noteCount} notes`} from ${backupDate(backup.createdAt)}`;
      await onRestored?.();
      if (isRoot) await revalidate();
      else pop();
    } catch (error) {
      await toast.hide();
      await showFailureToast(error, { title: "Could not restore the backup" });
    }
  }

  return (
    <List
      isLoading={isLoading}
      navigationTitle={isRoot ? undefined : "Restore Notes from Backup"}
      searchBarPlaceholder="Filter backups"
    >
      <List.EmptyView
        icon={Icon.HardDrive}
        title="No Backups"
        description="Overnote backs up your notes every day, and before every restore and database upgrade."
        actions={
          <ActionPanel>
            <BackUpNowAction onBackedUp={revalidate} />
            <RevealBackupsAction />
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
              <BackUpNowAction onBackedUp={revalidate} />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
