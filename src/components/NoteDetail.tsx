import { highlightMarkdownMatches } from "@overnote/core/text";
import { Detail } from "@raycast/api";

import { summaryTitle } from "../domain/format";
import type { NoteSummary } from "../domain/types";
import { useNote } from "../hooks/useNote";
import { NoteActions } from "./NoteActions";
import { NoteMetadata } from "./NoteMetadata";

export interface NoteDetailProps {
  note: NoteSummary;
  onChange: () => Promise<unknown> | void;
  /** The search text from Search Notes; its matches are bolded in the markdown. */
  highlight?: string;
}

/** A pushed view that renders the note's markdown with the same actions as the list. */
export function NoteDetail({ note, onChange, highlight }: NoteDetailProps) {
  const { data: full, isLoading } = useNote(note.id);
  const markdown = full?.markdown ?? note.preview;
  return (
    <Detail
      navigationTitle={summaryTitle(note)}
      isLoading={isLoading}
      markdown={highlight ? highlightMarkdownMatches(markdown, highlight) : markdown}
      metadata={<NoteMetadata note={note} variant="detail" />}
      actions={<NoteActions note={note} fullNote={full} onChange={onChange} isDetail />}
    />
  );
}
