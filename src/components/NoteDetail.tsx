import { countWords, highlightMarkdownMatches } from "@overnote/core/text";
import { Detail } from "@raycast/api";

import { summaryTitle, type PinPosition } from "../domain/format";
import type { NoteSummary } from "../domain/types";
import { useNote } from "../hooks/useNote";
import { NoteActions } from "./NoteActions";
import { NoteMetadata } from "./NoteMetadata";

export interface NoteDetailProps {
  note: NoteSummary;
  onChange: () => Promise<unknown> | void;
  /** The search text from Search Notes; its matches are bolded in the markdown. */
  highlight?: string;
  pinPosition?: PinPosition;
}

/** A pushed view that renders the note's markdown with the same actions as the list. */
export function NoteDetail({ note, onChange, highlight, pinPosition }: NoteDetailProps) {
  const { data: full, isLoading } = useNote(note.id);
  const markdown = full?.markdown ?? note.preview;
  return (
    <Detail
      navigationTitle={summaryTitle(note)}
      isLoading={isLoading}
      markdown={highlight ? highlightMarkdownMatches(markdown, highlight) : markdown}
      metadata={
        <NoteMetadata
          note={note}
          variant="detail"
          pinPosition={pinPosition}
          words={full ? countWords(full.text) : undefined}
        />
      }
      actions={<NoteActions note={note} fullNote={full} onChange={onChange} isDetail pinPosition={pinPosition} />}
    />
  );
}
