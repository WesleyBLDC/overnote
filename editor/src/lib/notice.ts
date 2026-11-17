/**
 * What a toast says (SPEC §11): its tone, which picks the status icon, and an optional action such as Undo. Shared by
 * the session, which raises notices, and the UI, which shows them, so neither depends on the other.
 */
export type NoticeKind = "info" | "success" | "warning" | "error";

export interface NoticeAction {
  label: string;
  /** Shown beside the label; ⌘Z also runs an Undo action while its toast shows and the note has nothing to undo. */
  shortcut?: string;
  run: () => void;
}

export type Notify = (message: string, kind?: NoticeKind, action?: NoticeAction) => void;
