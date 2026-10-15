import { Action, ActionPanel, Icon, List, closeMainWindow } from "@raycast/api";
import { showFailureToast } from "@raycast/utils";
import { useMemo, useState } from "react";

import { contentFromMarkdown } from "./api/content";
import { createNote } from "./api/notes";
import { NoteActions } from "./components/NoteActions";
import { NoteListItem } from "./components/NoteListItem";
import { groupIntoSections } from "./domain/sections";
import { useNote } from "./hooks/useNote";
import { useSearch } from "./hooks/useSearch";

async function createFromText(text: string) {
  try {
    await closeMainWindow();
    await createNote(contentFromMarkdown(text), { show: true });
  } catch (error) {
    await showFailureToast(error, { title: "Could not create a note" });
  }
}

export default function SearchNotes() {
  const [searchText, setSearchText] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const { data: notes = [], isLoading, revalidate, pagination } = useSearch(searchText);
  const { data: selected, isLoading: isLoadingSelected } = useNote(selectedId);

  const sections = useMemo(() => groupIntoSections(notes), [notes]);
  const pinnedIds = useMemo(() => notes.filter((note) => note.pinned !== null).map((note) => note.id), [notes]);
  const hasQuery = searchText.trim().length > 0;

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={notes.length > 0}
      filtering={false}
      throttle
      pagination={pagination}
      searchBarPlaceholder="Search notes"
      onSearchTextChange={setSearchText}
      onSelectionChange={(id) => setSelectedId(id ?? undefined)}
    >
      <List.EmptyView
        icon={Icon.Document}
        title={hasQuery ? "No Results" : "No Notes"}
        description={hasQuery ? "No notes contain this text." : "Create a note to get started."}
        actions={
          <ActionPanel>
            <Action
              title={hasQuery ? "Create Note from Search Text" : "Create Note"}
              icon={Icon.Plus}
              onAction={() => createFromText(hasQuery ? searchText : "")}
            />
          </ActionPanel>
        }
      />
      {sections.map((section) => (
        <List.Section key={section.name} title={section.name}>
          {section.notes.map((note) => (
            <NoteListItem
              key={note.id}
              note={note}
              fullNote={selected}
              isLoadingDetail={note.id === selectedId && isLoadingSelected}
              actions={
                <NoteActions
                  note={note}
                  fullNote={selected}
                  onChange={revalidate}
                  pinPosition={
                    note.pinned === null || hasQuery
                      ? undefined
                      : { isFirst: pinnedIds[0] === note.id, isLast: pinnedIds[pinnedIds.length - 1] === note.id }
                  }
                />
              }
            />
          ))}
        </List.Section>
      ))}
    </List>
  );
}
