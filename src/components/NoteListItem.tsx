import { highlightMarkdownMatches } from "@overnote/core/text";
import { Color, Icon, List } from "@raycast/api";
import type { ReactNode } from "react";

import { characterCount, previewWithoutTitle, summaryTitle } from "../domain/format";
import type { Note, NoteSummary } from "../domain/types";
import { NoteMetadata } from "./NoteMetadata";

export interface NoteListItemProps {
  note: NoteSummary & { markdown?: string };
  /** The loaded note when this row is selected, for the markdown detail. */
  fullNote?: Note | null;
  isLoadingDetail?: boolean;
  actions: ReactNode;
  /** Which date the accessory shows. */
  dateField?: "updatedAt" | "deletedAt";
  /** The active search text; its matches are bolded in the detail markdown. */
  highlight?: string;
}

/** One note row; the detail pane shows the full markdown once the row is selected and loaded. */
export function NoteListItem({
  note,
  fullNote,
  isLoadingDetail,
  actions,
  dateField = "updatedAt",
  highlight,
}: NoteListItemProps) {
  const title = summaryTitle(note);
  const subtitle = previewWithoutTitle(note);
  const date = dateField === "deletedAt" ? (note.deletedAt ?? note.updatedAt) : note.updatedAt;
  const markdown = fullNote && fullNote.id === note.id ? fullNote.markdown : (note.markdown ?? note.preview);

  return (
    <List.Item
      id={note.id}
      title={title}
      subtitle={subtitle}
      icon={note.pinned !== null ? { source: Icon.Pin, tintColor: Color.Orange } : Icon.Document}
      accessories={[
        { text: characterCount(note.charCount) },
        { date: new Date(date), tooltip: dateField === "deletedAt" ? "Deleted" : "Modified" },
      ]}
      detail={
        <List.Item.Detail
          isLoading={isLoadingDetail}
          markdown={highlight ? highlightMarkdownMatches(markdown, highlight) : markdown}
          metadata={<NoteMetadata note={note} variant="list" />}
        />
      }
      actions={actions}
    />
  );
}
