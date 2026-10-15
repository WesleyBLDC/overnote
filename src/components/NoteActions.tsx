import {
  Action,
  ActionPanel,
  Alert,
  Clipboard,
  Color,
  Icon,
  Keyboard,
  Toast,
  closeMainWindow,
  confirmAlert,
  showHUD,
  showToast,
  useNavigation,
} from "@raycast/api";
import { showFailureToast } from "@raycast/utils";

import { contentFromMarkdown, noteClipboard, noteToHTML } from "../api/content";
import {
  createNote,
  deleteAllNotes,
  deleteNote,
  duplicateNote,
  movePinnedDown,
  movePinnedUp,
  openInOvernote,
  pinNote,
  recoverNote,
  requireNote,
  unpinNote,
} from "../api/notes";
import { noteDeeplink } from "../domain/deeplink";
import { escapeNonAscii, summaryTitle } from "../domain/format";
import type { Note, NoteSummary } from "../domain/types";
import { BackupActionsSection } from "./BackupActions";
import { NoteDetail } from "./NoteDetail";

export interface NoteActionsProps {
  note: NoteSummary;
  /** The fully loaded note when the caller already has it. */
  fullNote?: Note | null;
  /** Revalidates the list after a write. */
  onChange: () => Promise<unknown> | void;
  /** True inside a pushed Detail, where "View Note" makes no sense. */
  isDetail?: boolean;
  /** Pin position, for Move Up and Move Down (only offered on pinned notes). */
  pinPosition?: { isFirst: boolean; isLast: boolean };
  /** The active search text, carried into View Note for highlighting. */
  highlight?: string;
}

type CopyFormat = "markdown" | "text" | "html";

const FORMAT_LABEL: Record<CopyFormat, string> = { markdown: "Markdown", text: "Plain Text", html: "HTML" };

/** The Search Notes action set, shared by the list rows and the pushed detail. */
export function NoteActions({ note, fullNote, onChange, isDetail, pinPosition, highlight }: NoteActionsProps) {
  const { pop } = useNavigation();
  const title = summaryTitle(note);
  const deeplink = noteDeeplink(note.id);
  const loadFull = async () => (fullNote && fullNote.id === note.id ? fullNote : requireNote(note.id));

  async function run(failureTitle: string, work: () => Promise<void>) {
    try {
      await work();
    } catch (error) {
      await showFailureToast(error, { title: failureTitle });
    }
  }

  const open = () => run("Could not open the note", () => openInOvernote(note.id));

  const copyContent = () =>
    run("Could not copy the note", async () => {
      const full = await loadFull();
      const flavors = noteClipboard(full);
      await Clipboard.copy({ html: escapeNonAscii(flavors.html), text: flavors.text });
      await showHUD("Copied to Clipboard");
    });

  const copyAs = (format: CopyFormat) =>
    run(`Could not copy the note as ${FORMAT_LABEL[format]}`, async () => {
      const full = await loadFull();
      if (format === "html") await Clipboard.copy(noteToHTML(full));
      else await Clipboard.copy(format === "markdown" ? full.markdown : full.text);
      await showHUD(`Copied as ${FORMAT_LABEL[format]}`);
    });

  const paste = () =>
    run("Could not paste the note", async () => {
      const full = await loadFull();
      await Clipboard.paste(full.markdown);
    });

  const togglePin = () =>
    run(note.pinned === null ? "Could not pin the note" : "Could not unpin the note", async () => {
      if (note.pinned === null) await pinNote(note.id);
      else await unpinNote(note.id);
      await onChange();
      await showToast({ title: note.pinned === null ? "Pinned Note" : "Unpinned Note" });
    });

  const move = (direction: "up" | "down") =>
    run(`Could not move the note ${direction}`, async () => {
      if (direction === "up") await movePinnedUp(note.id);
      else await movePinnedDown(note.id);
      await onChange();
      await showToast({ title: direction === "up" ? "Moved Note Up" : "Moved Note Down" });
    });

  const duplicate = () =>
    run("Could not duplicate the note", async () => {
      await duplicateNote(note.id, " (Copy)");
      await onChange();
      await showToast({ title: "Duplicated Note" });
    });

  // No confirmation: the note goes to Recently Deleted, and the toast can undo.
  const remove = () =>
    run("Could not delete the note", async () => {
      await deleteNote(note.id);
      await onChange();
      if (isDetail) pop();
      await showToast({
        title: "Moved to Recently Deleted",
        primaryAction: {
          title: "Undo",
          onAction: async (toast) => {
            await toast.hide();
            await run("Could not restore the note", async () => {
              await recoverNote(note.id);
              await onChange();
            });
          },
        },
      });
    });

  const removeAll = () =>
    run("Could not delete all notes", async () => {
      const confirmed = await confirmAlert({
        title: "Delete All Notes?",
        message: "All notes will move to Recently Deleted, where they can be restored.",
        icon: { source: Icon.Trash, tintColor: Color.Red },
        primaryAction: { title: "Delete All", style: Alert.ActionStyle.Destructive },
      });
      if (!confirmed) return;
      const count = await deleteAllNotes();
      await onChange();
      if (isDetail) pop();
      await showToast({
        style: Toast.Style.Success,
        title: count === 1 ? "Moved 1 Note to Recently Deleted" : `Moved ${count} Notes to Recently Deleted`,
      });
    });

  const create = () =>
    run("Could not create a note", async () => {
      await closeMainWindow();
      await createNote(contentFromMarkdown(""), { show: true });
    });

  const isPinned = note.pinned !== null;

  return (
    <ActionPanel title={title}>
      <ActionPanel.Section>
        <Action title="Open Note" icon={Icon.AppWindow} onAction={open} />
        <Action
          title={isPinned ? "Unpin Note" : "Pin Note"}
          icon={isPinned ? Icon.PinDisabled : Icon.Pin}
          shortcut={Keyboard.Shortcut.Common.Pin}
          onAction={togglePin}
        />
        {isPinned && pinPosition && !pinPosition.isFirst ? (
          <Action
            // "Up" matches "Move Down"; the title-case rule lowercases it as a preposition.
            // eslint-disable-next-line @raycast/prefer-title-case
            title="Move Up"
            icon={Icon.ArrowUp}
            shortcut={Keyboard.Shortcut.Common.MoveUp}
            onAction={() => move("up")}
          />
        ) : null}
        {isPinned && pinPosition && !pinPosition.isLast ? (
          <Action
            title="Move Down"
            icon={Icon.ArrowDown}
            shortcut={Keyboard.Shortcut.Common.MoveDown}
            onAction={() => move("down")}
          />
        ) : null}
        {isDetail ? null : (
          <Action.Push
            title="View Note"
            icon={Icon.Eye}
            shortcut={Keyboard.Shortcut.Common.ToggleQuickLook}
            target={<NoteDetail note={note} onChange={onChange} highlight={highlight} />}
          />
        )}
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action
          title="Copy Content"
          icon={Icon.Clipboard}
          shortcut={Keyboard.Shortcut.Common.Copy}
          onAction={copyContent}
        />
        <ActionPanel.Submenu
          title="Copy Note as…"
          icon={Icon.CopyClipboard}
          shortcut={Keyboard.Shortcut.Common.CopyName}
        >
          <Action title="Markdown" icon={Icon.Document} onAction={() => copyAs("markdown")} />
          <Action title="HTML" icon={Icon.Code} onAction={() => copyAs("html")} />
          <Action title="Plain Text" icon={Icon.Text} onAction={() => copyAs("text")} />
        </ActionPanel.Submenu>
        <Action
          title="Paste Note"
          icon={Icon.ArrowRightCircle}
          shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
          onAction={paste}
        />
        <Action.CopyToClipboard
          title="Copy Deeplink"
          content={deeplink}
          shortcut={{ modifiers: ["cmd", "shift"], key: "d" }}
        />
        <Action.CreateQuicklink
          title="Create Quicklink"
          quicklink={{ name: title, link: deeplink, icon: Icon.Document }}
          shortcut={{ modifiers: ["cmd", "shift"], key: "l" }}
        />
      </ActionPanel.Section>
      <ActionPanel.Section>
        <Action title="Create Note" icon={Icon.Plus} shortcut={Keyboard.Shortcut.Common.New} onAction={create} />
        <Action
          title="Duplicate Note"
          icon={Icon.Duplicate}
          shortcut={Keyboard.Shortcut.Common.Duplicate}
          onAction={duplicate}
        />
      </ActionPanel.Section>
      <BackupActionsSection onRestored={onChange} />
      <ActionPanel.Section>
        <Action
          title="Delete Note"
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={Keyboard.Shortcut.Common.Remove}
          onAction={remove}
        />
        <Action
          title="Delete All Notes"
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={Keyboard.Shortcut.Common.RemoveAll}
          onAction={removeAll}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}
