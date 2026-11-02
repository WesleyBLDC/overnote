import { countWords, highlightMarkdownMatches } from "@overnote/core/text";
import { Icon, List } from "@raycast/api";
import type { ReactNode } from "react";

import {
  characterCount,
  daysRemainingLabel,
  pinnedLabel,
  previewWithoutTitle,
  searchSnippet,
  summaryTitle,
  type PinPosition,
} from "../domain/format";
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
  /** This pinned note's place in pin order, when the caller has the complete pinned list. */
  pinPosition?: PinPosition;
}

/** One note row; the detail pane shows the full markdown once the row is selected and loaded. */
export function NoteListItem({
  note,
  fullNote,
  isLoadingDetail,
  actions,
  dateField = "updatedAt",
  highlight,
  pinPosition,
}: NoteListItemProps) {
  const title = summaryTitle(note);
  const subtitle = highlight
    ? (searchSnippet(note, highlight) ?? previewWithoutTitle(note))
    : previewWithoutTitle(note);
  const date = dateField === "deletedAt" ? (note.deletedAt ?? note.updatedAt) : note.updatedAt;
  const loaded = fullNote && fullNote.id === note.id ? fullNote : undefined;
  const markdown = loaded ? loaded.markdown : (note.markdown ?? note.preview);
  const accessories: React.ComponentProps<typeof List.Item>["accessories"] = [];
  if (note.pinned !== null) {
    accessories.push({
      icon: Icon.Pin,
      text: pinPosition ? (pinPosition.index <= 9 ? `⌘${pinPosition.index}` : `#${pinPosition.index}`) : undefined,
      tooltip: pinnedLabel(note, pinPosition),
    });
  }
  accessories.push({ text: characterCount(note.charCount), tooltip: "Characters" });
  if (dateField === "deletedAt" && note.deletedAt !== null) {
    accessories.push({ text: daysRemainingLabel(note.deletedAt), tooltip: "Time before permanent removal" });
  }
  accessories.push({ date: new Date(date), tooltip: dateField === "deletedAt" ? "Deleted" : "Modified" });

  return (
    <List.Item
      id={note.id}
      title={title}
      subtitle={subtitle}
      icon={note.pinned !== null ? Icon.Pin : Icon.Document}
      accessories={accessories}
      detail={
        <List.Item.Detail
          isLoading={isLoadingDetail}
          markdown={highlight ? highlightMarkdownMatches(markdown, highlight) : markdown}
          metadata={
            <NoteMetadata
              note={note}
              variant="list"
              pinPosition={pinPosition}
              words={loaded ? countWords(loaded.text) : undefined}
            />
          }
        />
      }
      actions={actions}
    />
  );
}
