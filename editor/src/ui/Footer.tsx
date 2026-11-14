import type { CountMode } from "@overnote/core";
import type { Editor } from "@tiptap/core";
import { characterLabel, wordLabel } from "../lib/relativeTime";
import { FormatBar } from "./FormatBar";
import { Icon } from "./icons";

interface Counts {
  characters: number;
  words: number;
}

interface FooterProps {
  editor: Editor | null;
  counts: Counts;
  /** What the selection holds, or null when nothing is selected. */
  selected: Counts | null;
  countMode: CountMode;
  showFormatBar: boolean;
  onToggleCount: () => void;
  openLink: () => void;
}

const number = (n: number) => n.toLocaleString("en-US");

/**
 * The bottom of the panel: an overlay, so it takes no height from the note. The count pill sits in the
 * bottom right corner, and the format island, when it is on (⌥⌘, or ⌘K), floats in the middle.
 */
export function Footer(props: FooterProps) {
  const words = props.countMode === "words";
  const total = words ? props.counts.words : props.counts.characters;
  const part = props.selected ? (words ? props.selected.words : props.selected.characters) : null;
  const label = words ? wordLabel(total) : characterLabel(total);
  return (
    <footer className="footer" data-testid="footer">
      {props.showFormatBar && props.editor ? (
        <div className="footer-center">
          <FormatBar editor={props.editor} openLink={props.openLink} />
        </div>
      ) : null}
      <button
        type="button"
        className="counter"
        data-testid="counter"
        aria-label={part === null ? label : `${number(part)} of ${label} selected`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onToggleCount}
        title="Switch between characters and words"
      >
        <span className="counter-value">{part === null ? number(total) : `${number(part)}/${number(total)}`}</span>
        <Icon name={words ? "words" : "format"} />
      </button>
    </footer>
  );
}
