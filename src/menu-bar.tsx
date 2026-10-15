import { Color, Icon, LaunchType, MenuBarExtra, launchCommand, showHUD } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";

import { backUpNow, revealBackupsFolder } from "./api/backups";
import { loadMenuData } from "./api/menu-data";
import { createNote, openInOvernote } from "./api/notes";
import { summaryTitle } from "./domain/format";
import type { NoteSummary } from "./domain/types";

async function run(failureTitle: string, work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    await showFailureToast(error, { title: failureTitle });
  }
}

function NoteItem({ note }: { note: NoteSummary }) {
  return (
    <MenuBarExtra.Item
      title={summaryTitle(note)}
      icon={note.pinned !== null ? Icon.Pin : Icon.Document}
      onAction={() => run("Could not open the note", () => openInOvernote(note.id))}
    />
  );
}

/** Loads the editor schema only when needed: the menu bar reloads every minute and rarely creates notes. */
async function newNote() {
  const { contentFromMarkdown } = await import("./api/content");
  await createNote(contentFromMarkdown(""), { show: true });
}

const openRestoreList = () =>
  run("Could not open the backups", () =>
    launchCommand({ name: "search-notes", type: LaunchType.UserInitiated, context: { restore: true } }),
  );

export default function MenuBar() {
  const { data, isLoading, error } = useCachedPromise(loadMenuData, [], { keepPreviousData: true });

  return (
    <MenuBarExtra icon={Icon.Document} tooltip="Overnote" isLoading={isLoading}>
      {data?.restoreAvailable ? (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item
            title="Restore Notes from Backup"
            subtitle="Backups found"
            icon={{ source: Icon.ArrowCounterClockwise, tintColor: Color.Orange }}
            onAction={openRestoreList}
          />
        </MenuBarExtra.Section>
      ) : null}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title="Open Overnote"
          icon={Icon.AppWindow}
          onAction={() => run("Could not open Overnote", () => openInOvernote())}
        />
        <MenuBarExtra.Item title="New Note" icon={Icon.Plus} onAction={() => run("Could not create a note", newNote)} />
      </MenuBarExtra.Section>
      {error ? (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title="Could Not Load Notes" subtitle={error.message} icon={Icon.ExclamationMark} />
        </MenuBarExtra.Section>
      ) : null}
      {data && data.pinned.length > 0 ? (
        <MenuBarExtra.Section title="Pinned">
          {data.pinned.map((note) => (
            <NoteItem key={note.id} note={note} />
          ))}
        </MenuBarExtra.Section>
      ) : null}
      {data && data.recent.length > 0 ? (
        <MenuBarExtra.Section title="Recent">
          {data.recent.map((note) => (
            <NoteItem key={note.id} note={note} />
          ))}
        </MenuBarExtra.Section>
      ) : null}
      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title="Search Notes"
          icon={Icon.MagnifyingGlass}
          onAction={() =>
            run("Could not open Search Notes", () =>
              launchCommand({ name: "search-notes", type: LaunchType.UserInitiated }),
            )
          }
        />
        <MenuBarExtra.Item
          title="Recently Deleted Notes"
          icon={Icon.Trash}
          onAction={() =>
            run("Could not open Recently Deleted", () =>
              launchCommand({ name: "recently-deleted", type: LaunchType.UserInitiated }),
            )
          }
        />
      </MenuBarExtra.Section>
      <MenuBarExtra.Section title="Backups">
        <MenuBarExtra.Item
          title="Back Up Notes Now"
          icon={Icon.SaveDocument}
          onAction={() =>
            run("Could not back up the notes", async () => {
              await backUpNow();
              await showHUD("Backed Up Notes");
            })
          }
        />
        <MenuBarExtra.Item
          title="Restore Notes from Backup"
          icon={Icon.ArrowCounterClockwise}
          onAction={openRestoreList}
        />
        <MenuBarExtra.Item
          title="Reveal Backups Folder"
          icon={Icon.Finder}
          onAction={() => run("Could not open the backups folder", revealBackupsFolder)}
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
