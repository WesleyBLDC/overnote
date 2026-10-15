import { Action, ActionPanel, Color, Icon, List, closeMainWindow, type LaunchProps } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";
import { useMemo, useState } from "react";

import { dismissRestoreOffer, loadRestoreOffer, type RestoreOffer } from "./api/backups";
import { contentFromMarkdown } from "./api/content";
import { createNote } from "./api/notes";
import { BackupActionsSection } from "./components/BackupActions";
import { NoteActions } from "./components/NoteActions";
import { NoteListItem } from "./components/NoteListItem";
import { RestoreBackupList } from "./components/RestoreBackupList";
import { backupDate } from "./domain/format";
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

const RESTORE_OFFER_ID = "restore-offer";

function restoreOfferMarkdown(offer: RestoreOffer): string {
  const count = offer.backupCount === 1 ? "1 backup" : `${offer.backupCount} backups`;
  const latest = offer.latest
    ? `\n\nThe latest is from ${backupDate(offer.latest.createdAt)} (Overnote ${offer.latest.version}).`
    : "";
  return `## Restore Your Notes\n\nOvernote started without any notes, but found ${count} in the backups folder. This usually means the extension was removed and installed again.${latest}\n\nRestoring replaces the current notes, which are backed up first.`;
}

/** The first row while the helper offers a restore (no database at startup, backups found). */
function RestoreOfferItem({ offer, onChange }: { offer: RestoreOffer; onChange: () => Promise<unknown> | void }) {
  const dismiss = async () => {
    try {
      await dismissRestoreOffer();
      await onChange();
    } catch (error) {
      await showFailureToast(error, { title: "Could not dismiss the offer" });
    }
  };
  return (
    <List.Section title="Backups">
      <List.Item
        id={RESTORE_OFFER_ID}
        icon={{ source: Icon.ArrowCounterClockwise, tintColor: Color.Orange }}
        title="Restore Notes from Backup"
        subtitle={offer.backupCount === 1 ? "1 backup found" : `${offer.backupCount} backups found`}
        detail={<List.Item.Detail markdown={restoreOfferMarkdown(offer)} />}
        actions={
          <ActionPanel>
            <Action.Push
              title="Restore Notes from Backup"
              icon={Icon.ArrowCounterClockwise}
              target={<RestoreBackupList onRestored={onChange} />}
            />
            <Action title="Dismiss" icon={Icon.XMarkCircle} onAction={dismiss} />
          </ActionPanel>
        }
      />
    </List.Section>
  );
}

type SearchContext = { restore?: unknown };

export default function SearchNotes(props: LaunchProps<{ launchContext?: SearchContext }>) {
  // The menu bar's "Restore Notes from Backup" opens straight into the backup list.
  if (props.launchContext?.restore === true) return <RestoreBackupList />;
  return <SearchNotesList />;
}

function SearchNotesList() {
  const [searchText, setSearchText] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const { data: notes = [], isLoading, revalidate, pagination } = useSearch(searchText);
  const { data: selected, isLoading: isLoadingSelected } = useNote(selectedId);
  const { data: offer, revalidate: revalidateOffer } = useCachedPromise(loadRestoreOffer, [], {
    keepPreviousData: true,
    onError: () => undefined,
  });
  const reload = async () => {
    await Promise.all([revalidate(), revalidateOffer()]);
  };

  const sections = useMemo(() => groupIntoSections(notes), [notes]);
  const pinnedIds = useMemo(() => notes.filter((note) => note.pinned !== null).map((note) => note.id), [notes]);
  const hasQuery = searchText.trim().length > 0;
  const showOffer = offer?.available === true && !hasQuery;

  return (
    <List
      isLoading={isLoading}
      isShowingDetail={notes.length > 0 || showOffer}
      filtering={false}
      throttle
      pagination={pagination}
      searchBarPlaceholder="Search notes"
      onSearchTextChange={setSearchText}
      onSelectionChange={(id) => setSelectedId(id && id !== RESTORE_OFFER_ID ? id : undefined)}
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
            <BackupActionsSection onRestored={reload} />
          </ActionPanel>
        }
      />
      {showOffer && offer ? <RestoreOfferItem offer={offer} onChange={reload} /> : null}
      {sections.map((section) => (
        <List.Section key={section.name} title={section.name}>
          {section.notes.map((note) => (
            <NoteListItem
              key={note.id}
              note={note}
              fullNote={selected}
              highlight={hasQuery ? searchText : undefined}
              isLoadingDetail={note.id === selectedId && isLoadingSelected}
              actions={
                <NoteActions
                  note={note}
                  fullNote={selected}
                  onChange={reload}
                  highlight={hasQuery ? searchText : undefined}
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
