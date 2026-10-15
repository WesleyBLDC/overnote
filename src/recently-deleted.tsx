import { Action, ActionPanel, Alert, Color, Icon, Keyboard, List, Toast, confirmAlert, showToast } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { useMemo, useState } from "react";

import { emptyTrash, permanentlyDeleteNote, recoverNote } from "./api/notes";
import { NoteListItem } from "./components/NoteListItem";
import { foldForMatch } from "./domain/fold";
import { summaryTitle } from "./domain/format";
import type { DeletedNoteSummary } from "./domain/types";
import { useDeletedNotes } from "./hooks/useDeletedNotes";

async function run(failureTitle: string, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    await showFailureToast(error, { title: failureTitle });
  }
}

function matches(note: DeletedNoteSummary, query: string): boolean {
  const needle = foldForMatch(query.trim());
  return needle.length === 0 || foldForMatch(`${note.title}\n${note.markdown}`).includes(needle);
}

function DeletedNoteActions({ note, onChange }: { note: DeletedNoteSummary; onChange: () => Promise<unknown> | void }) {
  const title = summaryTitle(note);

  const recover = () =>
    run("Could not restore the note", async () => {
      await recoverNote(note.id);
      await onChange();
      await showToast({ style: Toast.Style.Success, title: "Restored Note", message: title });
    });

  const deletePermanently = () =>
    run("Could not delete the note", async () => {
      const confirmed = await confirmAlert({
        title: "Permanently Delete Note?",
        message: `"${title}" will be deleted immediately. This cannot be undone.`,
        icon: { source: Icon.Trash, tintColor: Color.Red },
        primaryAction: { title: "Delete Permanently", style: Alert.ActionStyle.Destructive },
      });
      if (!confirmed) return;
      await permanentlyDeleteNote(note.id);
      await onChange();
      await showToast({ title: "Permanently Deleted Note", message: title });
    });

  const empty = () =>
    run("Could not empty Recently Deleted", async () => {
      const confirmed = await confirmAlert({
        title: "Empty Recently Deleted?",
        message: "Every note in Recently Deleted will be deleted immediately. This cannot be undone.",
        icon: { source: Icon.Trash, tintColor: Color.Red },
        primaryAction: { title: "Empty", style: Alert.ActionStyle.Destructive },
      });
      if (!confirmed) return;
      const count = await emptyTrash();
      await onChange();
      await showToast({ title: count === 1 ? "Permanently Deleted 1 Note" : `Permanently Deleted ${count} Notes` });
    });

  return (
    <ActionPanel title={title}>
      <Action title="Restore Note" icon={Icon.ArrowCounterClockwise} onAction={recover} />
      <Action.CopyToClipboard title="Copy Markdown" content={note.markdown} shortcut={Keyboard.Shortcut.Common.Copy} />
      <ActionPanel.Section>
        <Action
          title="Delete Permanently"
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={Keyboard.Shortcut.Common.Remove}
          onAction={deletePermanently}
        />
        <Action
          title="Empty Recently Deleted"
          icon={Icon.Trash}
          style={Action.Style.Destructive}
          shortcut={Keyboard.Shortcut.Common.RemoveAll}
          onAction={empty}
        />
      </ActionPanel.Section>
    </ActionPanel>
  );
}

export default function RecentlyDeleted() {
  const [searchText, setSearchText] = useState("");
  const { data: notes = [], isLoading, revalidate } = useDeletedNotes();
  const visible = useMemo(() => notes.filter((note) => matches(note, searchText)), [notes, searchText]);

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={visible.length > 0}
      filtering={false}
      searchBarPlaceholder="Search recently deleted notes"
      onSearchTextChange={setSearchText}
    >
      <List.EmptyView
        icon={Icon.Trash}
        title={searchText.trim().length > 0 ? "No Results" : "Recently Deleted Is Empty"}
        description="Notes in Recently Deleted will be permanently removed after 60 days."
      />
      <List.Section
        title="Recently Deleted"
        subtitle={searchText.trim().length > 0 ? undefined : "Notes are permanently removed after 60 days"}
      >
        {visible.map((note) => (
          <NoteListItem
            key={note.id}
            note={note}
            dateField="deletedAt"
            actions={<DeletedNoteActions note={note} onChange={revalidate} />}
          />
        ))}
      </List.Section>
    </List>
  );
}
