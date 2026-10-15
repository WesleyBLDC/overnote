import { Detail } from "@raycast/api";

import { summaryTitle } from "../domain/format";
import type { NoteSummary } from "../domain/types";
import { useNote } from "../hooks/useNote";
import { NoteActions } from "./NoteActions";
import { NoteMetadata } from "./NoteMetadata";

export interface NoteDetailProps {
  note: NoteSummary;
  onChange: () => Promise<unknown> | void;
}

/** A pushed view that renders the note's markdown with the same actions as the list. */
export function NoteDetail({ note, onChange }: NoteDetailProps) {
  const { data: full, isLoading } = useNote(note.id);
  return (
    <Detail
      navigationTitle={summaryTitle(note)}
      isLoading={isLoading}
      markdown={full?.markdown ?? note.preview}
      metadata={<NoteMetadata note={note} variant="detail" />}
      actions={<NoteActions note={note} fullNote={full} onChange={onChange} isDetail />}
    />
  );
}
