import { Detail, List } from "@raycast/api";

import {
  characterCount,
  daysRemainingLabel,
  pinnedLabel,
  summaryTitle,
  wordCount,
  type PinPosition,
} from "../domain/format";
import type { NoteSummary } from "../domain/types";

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function rows(note: NoteSummary, pinPosition?: PinPosition, words?: number): { title: string; text: string }[] {
  const items = [
    { title: "Title", text: summaryTitle(note) },
    { title: "Pinned", text: pinnedLabel(note, pinPosition) },
    { title: "Characters", text: characterCount(note.charCount) },
  ];
  if (words !== undefined) items.push({ title: "Words", text: wordCount(words) });
  items.push(
    { title: "Modified", text: dateFormat.format(note.updatedAt) },
    { title: "Created", text: dateFormat.format(note.createdAt) },
  );
  if (note.deletedAt !== null) {
    items.push({ title: "Deleted", text: dateFormat.format(note.deletedAt) });
    items.push({ title: "Permanent Removal", text: daysRemainingLabel(note.deletedAt) });
  }
  return items;
}

export interface NoteMetadataProps {
  note: NoteSummary;
  variant: "list" | "detail";
  pinPosition?: PinPosition;
  /** Word count from the fully loaded note text, when the caller has it. */
  words?: number;
}

/** Facts for a note, rendered for either a List detail pane or a pushed Detail. */
export function NoteMetadata({ note, variant, pinPosition, words }: NoteMetadataProps) {
  if (variant === "list") {
    return (
      <List.Item.Detail.Metadata>
        {rows(note, pinPosition, words).map((row) => (
          <List.Item.Detail.Metadata.Label key={row.title} title={row.title} text={row.text} />
        ))}
      </List.Item.Detail.Metadata>
    );
  }
  return (
    <Detail.Metadata>
      {rows(note, pinPosition, words).map((row) => (
        <Detail.Metadata.Label key={row.title} title={row.title} text={row.text} />
      ))}
    </Detail.Metadata>
  );
}
