import type { CountMode } from "@overnote/core";
import type { Editor } from "@tiptap/core";
import { characterLabel, wordLabel } from "../lib/relativeTime";
import { FormatBar } from "./FormatBar";
import { Icon } from "./icons";

interface FooterProps {
  editor: Editor | null;
  counts: { characters: number; words: number };
  countMode: CountMode;
  showFormatBar: boolean;
  onToggleCount: () => void;
  onToggleFormatBar: () => void;
  openLink: () => void;
  onMenuChange?: (open: boolean) => void;
}

/** Bottom bar: the counter (or the format bar) in the middle and the format bar toggle on the right. */
export function Footer(props: FooterProps) {
  const label = props.countMode === "words" ? wordLabel(props.counts.words) : characterLabel(props.counts.characters);
  return (
    <footer className="footer" data-testid="footer">
      <div className="footer-spacer" />
      <div className="footer-center">
        {props.showFormatBar && props.editor ? (
          <FormatBar editor={props.editor} openLink={props.openLink} onMenuChange={props.onMenuChange} />
        ) : (
          <button
            type="button"
            className="counter"
            data-testid="counter"
            onMouseDown={(event) => event.preventDefault()}
            onClick={props.onToggleCount}
            title="Switch between characters and words"
          >
            {label}
          </button>
        )}
      </div>
      <button
        type="button"
        className={`icon-button round chrome${props.showFormatBar ? " is-active" : ""}`}
        title={props.showFormatBar ? "Hide Format Buttons (⌥⌘,)" : "Show Format Buttons (⌥⌘,)"}
        aria-label={props.showFormatBar ? "Hide Format Buttons" : "Show Format Buttons"}
        data-testid="format-toggle"
        tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onToggleFormatBar}
      >
        <Icon name="sliders" />
      </button>
    </footer>
  );
}
