import { Color, Icon, LaunchType, MenuBarExtra, launchCommand, showHUD } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";

import { backUpNow, revealBackupsFolder } from "./api/backups";
import { loadMenuData } from "./api/menu-data";
import { createNote, openInOvernote } from "./api/notes";
import { showAndPlace } from "./api/window";
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
  const { data, isLoading, error, revalidate } = useCachedPromise(loadMenuData, [], { keepPreviousData: true });
  const hasNotes = data !== undefined && (data.pinned.length > 0 || data.recent.length > 0);

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
      <MenuBarExtra.Section title="Window">
        <MenuBarExtra.Item
          title="Fill Left"
          icon={Icon.AppWindowSidebarLeft}
          onAction={() =>
            run("Could not place the window", async () => {
              await showAndPlace("left");
            })
          }
        />
        <MenuBarExtra.Item
          title="Fill Right"
          icon={Icon.AppWindowSidebarRight}
          onAction={() =>
            run("Could not place the window", async () => {
              await showAndPlace("right");
            })
          }
        />
        <MenuBarExtra.Item
          title="Fill Screen"
          icon={Icon.Maximize}
          onAction={() =>
            run("Could not place the window", async () => {
              await showAndPlace("fill");
            })
          }
        />
        <MenuBarExtra.Item
          title="Centre"
          icon={Icon.Center}
          onAction={() =>
            run("Could not place the window", async () => {
              await showAndPlace("center");
            })
          }
        />
      </MenuBarExtra.Section>
      {error ? (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item
            title="Could Not Load Notes"
            subtitle={error.message}
            icon={{ source: Icon.ExclamationMark, tintColor: Color.Orange }}
            onAction={() => {
              void revalidate();
            }}
          />
        </MenuBarExtra.Section>
      ) : null}
      {data && !error && !hasNotes ? (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item
            title="Create Your First Note"
            subtitle="No notes yet"
            icon={Icon.Plus}
            onAction={() => run("Could not create a note", newNote)}
          />
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
