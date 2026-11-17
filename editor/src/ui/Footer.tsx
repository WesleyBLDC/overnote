import type { CountMode } from "@overnote/core";
import type { Editor } from "@tiptap/core";
import { countLabel, formatCount } from "../lib/count";
import { FormatBar } from "./FormatBar";
import { Icon } from "./icons";
import { Tooltip } from "./Tooltip";

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
  /** The format island is pinned open (Aa or ⌥⌘,). */
  showFormatBar: boolean;
  onToggleCount: () => void;
  onToggleFormatBar: () => void;
  openLink: () => void;
}

const keep = (event: React.MouseEvent) => event.preventDefault();

/**
 * The bottom row (board 05), an overlay that takes no height from the note. The corner holds the count, one
 * button whose icon says words or characters (click to switch), and Aa, which pins the format island. The
 * island, when pinned, floats in the middle.
 */
export function Footer(props: FooterProps) {
  const mode = props.countMode;
  const of = (counts: Counts) => (mode === "words" ? counts.words : counts.characters);
  // With a selection the corner shows only the selected count, never "7/1,244".
  const shown = props.selected ? of(props.selected) : of(props.counts);
  const label = props.selected ? `${countLabel(shown, mode)} selected` : countLabel(shown, mode);
  const pinned = props.showFormatBar;
  return (
    <footer className="footer" data-testid="footer">
      {pinned && props.editor ? (
        <div className="footer-center">
          <FormatBar editor={props.editor} openLink={props.openLink} />
        </div>
      ) : null}
      <div className="corner" data-testid="corner">
        <button
          type="button"
          className={`corner-chip corner-count has-tooltip${props.selected ? " is-selection" : ""}`}
          data-testid="counter"
          aria-label={label}
          onMouseDown={keep}
          onClick={props.onToggleCount}
          tabIndex={-1}
        >
          <span className="corner-count-value">{formatCount(shown)}</span>
          <Icon name={mode === "words" ? "words" : "characters"} />
          <Tooltip label={label} placement="above" />
        </button>
        <button
          type="button"
          className={`corner-chip corner-aa has-tooltip${pinned ? " is-active" : ""}`}
          data-testid="pin-format"
          aria-label={pinned ? "Unpin Format Island" : "Pin Format Island"}
          aria-pressed={pinned}
          onMouseDown={keep}
          onClick={props.onToggleFormatBar}
          tabIndex={-1}
        >
          Aa
          <Tooltip label={pinned ? "Unpin Format Island" : "Pin Format Island"} shortcut="⌥⌘," placement="above" />
        </button>
      </div>
    </footer>
  );
}
