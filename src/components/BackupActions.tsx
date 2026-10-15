import { Action, ActionPanel, Icon } from "@raycast/api";

import { BackUpNowAction, RevealBackupsAction } from "./BackupBasicActions";
import { RestoreBackupList } from "./RestoreBackupList";

/** Back Up Notes Now, Restore Notes from Backup, and Reveal Backups Folder, for any action panel. */
export function BackupActionsSection({ onRestored }: { onRestored?: () => Promise<unknown> | void }) {
  return (
    <ActionPanel.Section title="Backups">
      <BackUpNowAction />
      <Action.Push
        title="Restore Notes from Backup"
        icon={Icon.ArrowCounterClockwise}
        target={<RestoreBackupList onRestored={onRestored} />}
      />
      <RevealBackupsAction />
    </ActionPanel.Section>
  );
}
