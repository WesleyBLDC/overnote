import { Detail, List } from "@raycast/api";

import { summaryTitle } from "../domain/format";
import type { NoteSummary } from "../domain/types";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function rows(note: NoteSummary): { title: string; text: string }[] {
  const items = [
    { title: "Title", text: summaryTitle(note) },
    { title: "Modified", text: dateFormat.format(note.updatedAt) },
    { title: "Created", text: dateFormat.format(note.createdAt) },
  ];
  if (note.deletedAt !== null) items.push({ title: "Deleted", text: dateFormat.format(note.deletedAt) });
  return items;
}

/** Dates for a note, rendered for either a List detail pane or a pushed Detail. */
export function NoteMetadata({ note, variant }: { note: NoteSummary; variant: "list" | "detail" }) {
  if (variant === "list") {
    return (
      <List.Item.Detail.Metadata>
        {rows(note).map((row) => (
          <List.Item.Detail.Metadata.Label key={row.title} title={row.title} text={row.text} />
        ))}
      </List.Item.Detail.Metadata>
    );
  }
  return (
    <Detail.Metadata>
      {rows(note).map((row) => (
        <Detail.Metadata.Label key={row.title} title={row.title} text={row.text} />
      ))}
    </Detail.Metadata>
  );
}
