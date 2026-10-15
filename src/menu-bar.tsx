import { Icon, LaunchType, MenuBarExtra, launchCommand } from "@raycast/api";
import { showFailureToast, useCachedPromise } from "@raycast/utils";

import { contentFromMarkdown } from "./api/content";
import { loadMenuData } from "./api/menu-data";
import { createNote, openInBetterNotes } from "./api/notes";
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
      onAction={() => run("Could not open the note", () => openInBetterNotes(note.id))}
    />
  );
}

export default function MenuBar() {
  const { data, isLoading, error } = useCachedPromise(loadMenuData, [], { keepPreviousData: true });

  return (
    <MenuBarExtra icon={Icon.Document} tooltip="Better Notes" isLoading={isLoading}>
      <MenuBarExtra.Section>
        <MenuBarExtra.Item
          title="Open Better Notes"
          icon={Icon.AppWindow}
          onAction={() => run("Could not open Better Notes", () => openInBetterNotes())}
        />
        <MenuBarExtra.Item
          title="New Note"
          icon={Icon.Plus}
          onAction={() =>
            run("Could not create a note", async () => {
              await createNote(contentFromMarkdown(""), { show: true });
            })
          }
        />
      </MenuBarExtra.Section>
      {error ? (
        <MenuBarExtra.Section>
          <MenuBarExtra.Item title="Helper unavailable" subtitle={error.message} icon={Icon.ExclamationMark} />
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
          title="Recently Deleted"
          icon={Icon.Trash}
          onAction={() =>
            run("Could not open Recently Deleted", () =>
              launchCommand({ name: "recently-deleted", type: LaunchType.UserInitiated }),
            )
          }
        />
      </MenuBarExtra.Section>
    </MenuBarExtra>
  );
}
